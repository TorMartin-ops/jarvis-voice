// Checks that every audio tag Jarvis may use is performed, not read aloud.
// For each tag: synthesize "[tag] <sentence>" with the configured TTS model, transcribe the
// audio with ElevenLabs STT, and fail if the tag's words show up in the transcript.
// Uses API credits (about 12 short TTS and STT calls). Run: node test/tags.mjs
import { join } from "path";
import { loadConfig, loadDotEnv } from "../dist/config.js";
import { SpeechToText } from "../dist/stt.js";
import { AUDIO_TAGS } from "../dist/split.js";

loadDotEnv(join(process.cwd(), ".env"));
const cfg = loadConfig();
const sentence = "Ja vel, da gjør vi det.";
const stt = new SpeechToText({ apiKey: cfg.elevenKey, model: cfg.sttModel, language: cfg.language });

async function tts(text) {
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.ttsVoice}?output_format=pcm_16000`, {
    method: "POST",
    headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
    body: JSON.stringify({ text, model_id: cfg.ttsModel }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function transcribe(pcm) {
  const session = stt.open();
  if (!session) throw new Error("STT budget exhausted");
  const step = 16000 * 2 * 0.1;
  for (let i = 0; i < pcm.length; i += step) session.write(pcm.subarray(i, i + step));
  return session.commit();
}

let failed = 0;
for (const tag of AUDIO_TAGS) {
  const audio = await tts(`[${tag}] ${sentence}`);
  const heard = (await transcribe(audio)).toLowerCase();
  const leaked = tag.split(" ").some((w) => w.length > 3 && heard.includes(w));
  const seconds = (audio.length / 32000).toFixed(1);
  console.log(`${leaked ? "LEAK" : "ok  "} [${tag}] ${seconds}s -> "${heard}"`);
  if (leaked) failed++;
}
stt.dispose();
console.log(failed ? `\n${failed} tag(s) were read aloud` : "\nall tags performed, none read aloud");
process.exit(failed ? 1 : 0);
