import { join } from "path";
import { loadConfig, loadDotEnv, ConfigError } from "./config.js";
import { startMic, listMicDevices, type Mic } from "./mic.js";
import { Speaker } from "./speaker.js";
import { SpeechBuffer } from "./audio-utils.js";
import { SpeechToText } from "./stt.js";
import { Brain } from "./brain.js";
import { ClaudeMcp } from "./mcp.js";
import { WakeGate } from "./gate.js";
import { Conversation } from "./conversation.js";
import { redact } from "./policy.js";

function log(msg: string): void {
  console.log(`${new Date().toLocaleTimeString("nb-NO")} ${redact(msg)}`);
}

async function main(): Promise<void> {
  process.env.VOICE_DEBUG ??= "1";
  loadDotEnv(join(process.cwd(), ".env"));

  if (process.argv.includes("--devices")) {
    const names = await listMicDevices();
    console.log(names.length ? names.map((n) => `JARVIS_MIC="${n}"`).join("\n") : "No audio devices found.");
    return;
  }

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  // Claude Code tools over MCP. If it fails, the brain runs without tools and says so.
  const mcp = new ClaudeMcp({
    claudeBin: cfg.claudeBin,
    cwd: cfg.workerCwd,
    allow: cfg.toolAllow,
    timeoutMs: cfg.toolTimeoutMs,
  });
  try {
    await mcp.connect();
    log(`Claude Code tools: ${mcp.getTools().map((t) => t.name).join(", ")}`);
  } catch (err) {
    log(`Claude Code tools unavailable, running without them: ${(err as Error).message}`);
  }

  const brain = new Brain({
    endpoint: cfg.azure.endpoint,
    apiKey: cfg.azure.key,
    deployment: cfg.azure.deployment,
    apiVersion: cfg.azure.apiVersion,
    tools: () => (mcp.connected ? mcp.getTools() : []),
    runTool: (name, args) => mcp.call(name, args),
  });

  const conversation = new Conversation({
    buffer: await SpeechBuffer.create(cfg.endSilenceMs ? { silenceDuration: cfg.endSilenceMs } : {}),
    stt: new SpeechToText({ apiKey: cfg.elevenKey, model: cfg.sttModel, language: cfg.language }),
    brain,
    speaker: new Speaker(cfg.ffplayPath),
    gate: new WakeGate(cfg.wakeWords, cfg.wakeWindowMs),
    tts: { apiKey: cfg.elevenKey, voice: cfg.ttsVoice, model: cfg.ttsModel },
    bargeInMs: cfg.bargeInMs,
    mergeMs: cfg.mergeMs,
    log,
  });

  let mic: Mic | null = null;
  const shutdown = async () => {
    log("stopping");
    mic?.stop();
    await conversation.shutdown();
    await mcp.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  mic = startMic(
    cfg.micDevice,
    (pcm) => conversation.onMic(pcm),
    (msg) => log(`microphone: ${msg}`),
  );
  log(`listening on "${cfg.micDevice}". Say "${cfg.wakeWords[0] ?? "Claude"}" to start.`);
}

main().catch((err) => {
  console.error(redact(`fatal: ${(err as Error).stack ?? err}`));
  process.exit(1);
});
