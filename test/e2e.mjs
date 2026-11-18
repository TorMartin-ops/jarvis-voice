// End-to-end check with real services, no microphone needed.
// Speaks test phrases with ElevenLabs and feeds the audio through the whole assistant:
// VAD, STT, wake gate, Luna, Claude Code workers, TTS and the speaker. Uses API credits.
//
//   npm run e2e -- "Jarvis, hva er klokka?"
//   npm run e2e -- "Jarvis, send ... | ja, send" --dry-tasks   several turns, workers not started
//   flags: --task (wait for a worker and Luna's report), --echo (feed own audio back into the mic),
//          --greet (start-up greeting first), --dry-tasks (record tasks instead of running them)
import { join } from "path";
import { loadConfig, loadDotEnv } from "../dist/config.js";
import { createAssistant } from "../dist/index.js";

process.env.VOICE_DEBUG ??= "2";
loadDotEnv(join(process.cwd(), ".env"));
const cfg = loadConfig();
const arg = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Jarvis, hva er klokka?";
const phrases = arg.split("|").map((p) => p.trim()).filter(Boolean);
const flag = (f) => process.argv.includes(f);
const log = (m) => console.log(`${new Date().toLocaleTimeString("nb-NO")} ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Half-second chunks, like ffmpeg with default DirectShow buffering: catches framing bugs that 20 ms chunks hide.
const CHUNK = 16000 * 2 * 0.5;

async function speak(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.ttsVoice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: cfg.ttsModel }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

function resample24to16(pcm) {
  const n = pcm.length / 2;
  const out = Buffer.alloc(Math.floor(n / 1.5) * 2);
  for (let j = 0; j < out.length / 2; j++) {
    const pos = j * 1.5, i = Math.floor(pos), f = pos - i;
    const a = pcm.readInt16LE(Math.min(i, n - 1) * 2), b = pcm.readInt16LE(Math.min(i + 1, n - 1) * 2);
    out.writeInt16LE(Math.round(a + (b - a) * f), j * 2);
  }
  return out;
}

if (flag("--echo")) cfg.audioMode = "speakers";
let convRef = null;
let heard = 0;
let finished = 0;
const { conversation, tasks } = await createAssistant(
  cfg,
  (m) => {
    log(m);
    if (/^heard: /.test(m)) heard++;
    if (/^task \S+ (done|failed|timeout|cancelled)/.test(m)) finished++;
  },
  flag("--echo") ? { onAudioOut: (pcm) => convRef?.onMic(resample24to16(pcm)) } : {},
);
convRef = conversation;

if (flag("--dry-tasks")) {
  tasks.start = (title, description, confirmedAction) => {
    log(`DRY task "${title}" confirmed_action=${confirmedAction ? JSON.stringify(confirmedAction) : "none"}`);
    return { id: "dry1", title, description, confirmedAction, status: "running", startedAt: new Date().toISOString(), progress: "", steps: 0 };
  };
}

async function feed(pcm) {
  for (let i = 0; i < pcm.length; i += CHUNK) {
    conversation.onMic(pcm.subarray(i, i + CHUNK));
    await sleep(20);
  }
}

async function waitIdle(maxMs) {
  const end = Date.now() + maxMs;
  let busy = false;
  while (Date.now() < end) {
    await sleep(250);
    if (conversation.state !== "listening") busy = true;
    if (busy && conversation.state === "listening") {
      await sleep(1500);
      if (conversation.state === "listening") return true;
    }
  }
  return busy;
}

const started = Date.now();
if (flag("--greet")) {
  conversation.greet();
  await waitIdle(30_000);
}
for (const p of phrases) {
  log(`user says: "${p}"`);
  await feed(Buffer.concat([Buffer.alloc(32000), await speak(p), Buffer.alloc(32000)]));
  await waitIdle(60_000);
}
if (flag("--task")) {
  const end = Date.now() + 300_000;
  while (finished === 0 && Date.now() < end) await sleep(500);
  await waitIdle(60_000);
}
if (flag("--echo")) {
  await feed(Buffer.alloc(16000 * 2 * 1.5)); // room silence so the echoed utterance is closed and transcribed
  await sleep(6000);
}

log(`finished in ${Date.now() - started} ms: heard ${heard} of ${phrases.length} request(s), tasks finished ${finished}`);
if (flag("--echo")) log(heard === phrases.length ? "ECHO TEST PASSED" : "ECHO TEST FAILED");
tasks.shutdown();
await conversation.shutdown();
setTimeout(() => process.exit(0), 1500);
