// End-to-end check with real services, no microphone needed.
// It speaks a test phrase with ElevenLabs, feeds that audio through the whole
// pipeline (VAD, STT, wake gate, Azure brain, Claude Code tools, TTS, speaker),
// and prints each step. Costs a few cents. Run with: node test/e2e.mjs
import { join } from "path";
import { loadConfig, loadDotEnv } from "../dist/config.js";
import { SpeechBuffer } from "../dist/audio-utils.js";
import { SpeechToText } from "../dist/stt.js";
import { Brain } from "../dist/brain.js";
import { ClaudeMcp } from "../dist/mcp.js";
import { WakeGate } from "../dist/gate.js";
import { Speaker } from "../dist/speaker.js";
import { Conversation } from "../dist/conversation.js";

loadDotEnv(join(process.cwd(), ".env"));
const cfg = loadConfig();
const phrase = process.argv[2] ?? "Claude, hvilken mappe er du i?";
const log = (m) => console.log(`${new Date().toISOString().slice(11, 19)} ${m}`);

// 1. Speak the phrase as 16 kHz PCM (what the microphone would deliver).
log(`synthesizing: "${phrase}"`);
const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.ttsVoice}?output_format=pcm_16000`, {
  method: "POST",
  headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
  body: JSON.stringify({ text: phrase, model_id: cfg.ttsModel }),
});
if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
const speech = Buffer.from(await res.arrayBuffer());
const silence = Buffer.alloc(16000 * 2 * 1); // 1 s of silence before and after
const audio = Buffer.concat([silence, speech, silence]);

// 2. Tools and brain.
const mcp = new ClaudeMcp({ claudeBin: cfg.claudeBin, cwd: cfg.workerCwd, allow: cfg.toolAllow, timeoutMs: cfg.toolTimeoutMs });
await mcp.connect();
log(`tools: ${mcp.getTools().map((t) => t.name).join(", ")}`);
const brain = new Brain({
  endpoint: cfg.azure.endpoint,
  apiKey: cfg.azure.key,
  deployment: cfg.azure.deployment,
  apiVersion: cfg.azure.apiVersion,
  tools: () => mcp.getTools(),
  runTool: (n, a) => mcp.call(n, a),
});

// 3. Pipeline.
const speaker = new Speaker(cfg.ffplayPath);
const conv = new Conversation({
  buffer: await SpeechBuffer.create(),
  stt: new SpeechToText({ apiKey: cfg.elevenKey, model: cfg.sttModel, language: cfg.language }),
  brain,
  speaker,
  gate: new WakeGate(cfg.wakeWords, cfg.wakeWindowMs),
  tts: { apiKey: cfg.elevenKey, voice: cfg.ttsVoice, model: cfg.ttsModel },
  bargeInMs: cfg.bargeInMs,
  mergeMs: cfg.mergeMs,
  log,
});

// 4. Feed audio at real time (20 ms chunks), then wait until the assistant is idle again.
const started = Date.now();
const CHUNK = 16000 * 2 * 0.02;
for (let i = 0; i < audio.length; i += CHUNK) {
  conv.onMic(audio.subarray(i, i + CHUNK));
  await new Promise((r) => setTimeout(r, 20));
}
const deadline = Date.now() + 90_000;
let sawBusy = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 250));
  if (conv.state !== "listening") sawBusy = true;
  if (sawBusy && conv.state === "listening") break;
}
log(sawBusy ? `done in ${Date.now() - started} ms` : "no reply within 90 s: check the log lines above");
await conv.shutdown();
await mcp.close();
setTimeout(() => process.exit(0), 3000);
