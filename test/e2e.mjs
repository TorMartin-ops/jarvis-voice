// End-to-end check with real services, no microphone needed.
// Speaks a test phrase with ElevenLabs and feeds the audio through the whole
// assistant: VAD, STT, wake gate, Luna, a Claude Code worker if Luna delegates,
// TTS and the speaker. Prints each step. Uses API credits.
// Run: npm run e2e -- "Jarvis, ..."   (add --task to wait for a delegated task)
import { join } from "path";
import { loadConfig, loadDotEnv } from "../dist/config.js";
import { createAssistant } from "../dist/index.js";

process.env.VOICE_DEBUG ??= "2";
loadDotEnv(join(process.cwd(), ".env"));
const cfg = loadConfig();
const phrase = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "Jarvis, hva er klokka?";
const waitForTask = process.argv.includes("--task");
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

log(`synthesizing: "${phrase}"`);
const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.ttsVoice}?output_format=pcm_16000`, {
  method: "POST",
  headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
  body: JSON.stringify({ text: phrase, model_id: cfg.ttsModel }),
});
if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
const speech = Buffer.from(await res.arrayBuffer());
const silence = Buffer.alloc(16000 * 2);
const audio = Buffer.concat([silence, speech, silence]);

let finishedTasks = 0;
const { conversation, tasks } = await createAssistant(cfg, (m) => {
  log(m);
  if (/^task \S+ (done|failed|timeout|cancelled)/.test(m)) finishedTasks++;
});

const started = Date.now();
const CHUNK = 16000 * 2 * 0.02;
for (let i = 0; i < audio.length; i += CHUNK) {
  conversation.onMic(audio.subarray(i, i + CHUNK));
  await new Promise((r) => setTimeout(r, 20));
}

// Wait for the reply; with --task, also for the worker and Luna's spoken report.
const deadline = Date.now() + (waitForTask ? 300_000 : 90_000);
let sawBusy = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  if (conversation.state !== "listening") sawBusy = true;
  const idle = sawBusy && conversation.state === "listening";
  if (idle && (!waitForTask || finishedTasks > 0)) {
    await new Promise((r) => setTimeout(r, 1500));
    if (conversation.state === "listening") break;
  }
}
const running = tasks.list().filter((t) => t.status === "running").length;
log(`${sawBusy ? "done" : "no reply"} in ${Date.now() - started} ms; tasks finished: ${finishedTasks}, still running: ${running}`);
tasks.shutdown();
await conversation.shutdown();
setTimeout(() => process.exit(0), 2000);
