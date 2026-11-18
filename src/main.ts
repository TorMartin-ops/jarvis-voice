import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Client, Events, GatewayIntentBits, type VoiceBasedChannel } from "discord.js";
import { VoicePipeline, type VoicePipelineConfig } from "./voice-pipeline.js";
import { Brain, type BrainHooks } from "./brain.js";
import { CliBrain } from "./brain-cli.js";
import { AzureBrain } from "./brain-azure.js";

type VoiceBrain = { note(text: string): void; respond(userText: string | null, hooks: BrainHooks, signal?: AbortSignal): Promise<void> };
import { SentenceSplitter } from "./split.js";
import { startWorker, type WorkerResult } from "./worker.js";

/** Load KEY=VALUE lines into process.env without overriding values already set. */
function loadEnvFile(path: string): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(join(process.cwd(), ".env"));
// The Discord bot token is shared with the Discord text plugin; reuse that file.
loadEnvFile(process.env.DISCORD_ENV_FILE || join(homedir(), ".claude", "channels", "discord", ".env"));

const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN?.trim();
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY?.trim();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const GUILD_ID = process.env.JARVIS_GUILD_ID?.trim();
const CHANNEL_ID = process.env.JARVIS_CHANNEL_ID?.trim();

function fail(msg: string): never {
  console.error(`jarvis-voice: ${msg}`);
  process.exit(1);
}
if (!DISCORD_TOKEN) fail("DISCORD_BOT_TOKEN is missing (set it in the Discord plugin .env or here).");
if (!ELEVEN_KEY) fail("ELEVENLABS_API_KEY is missing.");
if (!GUILD_ID || !CHANNEL_ID) fail("JARVIS_GUILD_ID and JARVIS_CHANNEL_ID must be set.");

const num = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : undefined;
};

const config: VoicePipelineConfig = {
  elevenLabsApiKey: ELEVEN_KEY!,
  sttModel: process.env.ELEVENLABS_STT_MODEL?.trim() || undefined,
  ttsModel: process.env.ELEVENLABS_TTS_MODEL?.trim() || undefined,
  language: process.env.VOICE_DEFAULT_LANGUAGE?.trim() || undefined,
  voice: process.env.VOICE_DEFAULT_VOICE?.trim() || undefined,
  endSilenceMs: num(process.env.VOICE_END_SILENCE_MS),
  mergeMs: num(process.env.VOICE_MERGE_MS),
  bargeInMs: num(process.env.VOICE_BARGE_IN_MS),
  sttDailySeconds: num(process.env.VOICE_STT_DAILY_SECONDS),
  ttsDailyChars: num(process.env.VOICE_TTS_DAILY_CHARS),
};

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});
const pipeline = new VoicePipeline(client, config);
// Brain choice: Azure OpenAI if configured, else Anthropic API, else Claude Code on this PC.
const AZURE_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT?.trim();
const AZURE_KEY = process.env.AZURE_OPENAI_API_KEY?.trim();
const AZURE_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT?.trim();
let brain: VoiceBrain;
let brainName: string;
if (AZURE_ENDPOINT && AZURE_KEY && AZURE_DEPLOYMENT) {
  brain = new AzureBrain(AZURE_ENDPOINT, AZURE_KEY, AZURE_DEPLOYMENT, process.env.AZURE_OPENAI_API_VERSION?.trim() || undefined);
  brainName = `azure:${AZURE_DEPLOYMENT}`;
} else if (ANTHROPIC_KEY) {
  brain = new Brain(ANTHROPIC_KEY);
  brainName = "anthropic-api";
} else {
  brain = new CliBrain();
  brainName = "claude-code (no API key)";
}
console.error(`jarvis-voice: brain = ${brainName}`);

let current: AbortController | null = null;
/** Brain turns run one at a time, in arrival order. */
let chain: Promise<void> = Promise.resolve();

function speak(text: string): void {
  void pipeline.playResponse(text);
}

function runTurn(userText: string | null): void {
  if (userText !== null) current?.abort();
  const controller = new AbortController();
  current = controller;
  const splitter = new SentenceSplitter();
  chain = chain.then(async () => {
    if (controller.signal.aborted) return;
    // A report turn (null) must not abort; it only runs after the current turn finishes.
    try {
      await brain.respond(
        userText,
        {
          onText: (chunk) => {
            for (const s of splitter.push(chunk)) speak(s);
          },
          onDelegate: (description) => {
            const id = `${Date.now().toString(36)}`;
            console.error(`jarvis-voice: worker ${id} started`);
            startWorker(id, description, onWorkerDone);
            return `Started worker ${id}. It is running in the background; the result will arrive later.`;
          },
        },
        controller.signal,
      );
      for (const s of splitter.flush()) speak(s);
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error("jarvis-voice: brain error:", (err as Error).message);
        speak("Jeg fikk en feil. Prøv igjen.");
      }
    }
  });
}

function onWorkerDone(r: WorkerResult): void {
  console.error(`jarvis-voice: worker ${r.id} done (ok=${r.ok}) report=${r.reportPath}`);
  brain.note(`[Oppgave ferdig] ${r.summary}`);
  runTurn(null);
}

pipeline.onTranscription((_userId, username, text) => {
  console.error(`jarvis-voice: heard from ${username}`);
  runTurn(text);
});

client.once(Events.ClientReady, async (ready) => {
  console.error(`jarvis-voice: logged in as ${ready.user.tag}`);
  const guild = client.guilds.cache.get(GUILD_ID!) ?? (await client.guilds.fetch(GUILD_ID!));
  const channel = (await guild.channels.fetch(CHANNEL_ID!)) as VoiceBasedChannel | null;
  if (!channel || !channel.isVoiceBased()) fail("JARVIS_CHANNEL_ID is not a voice channel in that guild.");
  await pipeline.join(channel as any);
  console.error(`jarvis-voice: joined "${channel.name}"`);
  brain.note("[Samtalen startet. Si hei kort.]");
  runTurn(null);
});

client.login(DISCORD_TOKEN!).catch((e) => fail(`Discord login failed: ${e.message}`));
process.on("SIGINT", () => {
  pipeline.leave();
  process.exit(0);
});
