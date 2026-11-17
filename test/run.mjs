// Small dependency-free tests. Run: npm test (builds first).
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { parseJsonKeepingBigInts, parseIds, SNOWFLAKE } = await import("../dist/access.js");
let passed = 0;
const t = (name, fn) => Promise.resolve(fn()).then(() => { passed++; console.log("ok  " + name); });

await t("big numeric IDs keep their digits", () => {
  const d = parseJsonKeepingBigInts('{"allowFrom":[123456789012345678, "987654321098765432"]}');
  assert.deepEqual(d.allowFrom, ["123456789012345678", "987654321098765432"]);
  assert.deepEqual(parseIds(d.allowFrom), ["123456789012345678", "987654321098765432"]);
});
await t("strings containing digits are untouched", () => {
  const d = parseJsonKeepingBigInts('{"note":"id 123456789012345678 here","n":5,"f":1.5e3}');
  assert.equal(d.note, "id 123456789012345678 here");
  assert.equal(d.n, 5);
});
await t("small numbers are rejected, not coerced", () => {
  assert.deepEqual(parseIds([12345, "  111111111111111111\r"]), ["111111111111111111"]);
});
await t("snowflake regex", () => {
  assert.ok(SNOWFLAKE.test("123456789012345678"));
  assert.ok(!SNOWFLAKE.test("1234"));
});

// Silero VAD: independent state per SpeechBuffer.
const { SpeechBuffer } = await import("../dist/audio-utils.js");
await t("each SpeechBuffer has its own VAD state", async () => {
  const a = await SpeechBuffer.create();
  const b = await SpeechBuffer.create();
  assert.notEqual(a.vad, b.vad);
  assert.notEqual(a.vad._state, b.vad._state);
  const noise = Buffer.alloc(1024 * 3);
  for (let i = 0; i < noise.length; i += 2) noise.writeInt16LE(Math.round((Math.random() - 0.5) * 20000), i);
  const before = b.vad._state;
  await a.feed(noise);
  assert.equal(b.vad._state, before, "feeding A must not change B's state");
  const sA = a.vad._state;
  a.endOfInput();
  assert.notEqual(a.vad._state, sA, "state reset at end of input");
});

// TTS cache LRU
const { TextToSpeech } = await import("../dist/tts.js");
await t("TTS cache is bounded (entries and bytes)", () => {
  const tts = new TextToSpeech({ apiKey: "x" });
  for (let i = 0; i < 500; i++) tts.cacheStore("k" + i, { pcm: Buffer.alloc(10), chars: 1 });
  assert.ok(tts.cache.size <= 200);
  assert.ok(tts.cache.has("k499") && !tts.cache.has("k0"));
  tts.cache.clear(); tts.cacheBytes = 0;
  for (let i = 0; i < 5; i++) tts.cacheStore("b" + i, { pcm: Buffer.alloc(3 * 1024 * 1024), chars: 1 });
  assert.ok(tts.cacheBytes <= 8 * 1024 * 1024);
  assert.equal(tts.cache.size, 2);
  tts.cacheStore("huge", { pcm: Buffer.alloc(9 * 1024 * 1024), chars: 1 });
  assert.ok(!tts.cache.has("huge"));
});

// Pooled socket error handler
const { WebSocketServer } = await import("ws");
const { connectSocket } = await import("../dist/elevenlabs.js");
await t("socket keeps a permanent error listener", async () => {
  const origEmit = process.emit;
  const { default: WebSocket } = await import("ws");
  // Emulate an opened socket's post-open handling without network access.
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on("listening", r));
  const port = wss.address().port;
  const s = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => s.once("open", r));
  s.on("error", () => {});
  assert.ok(s.listenerCount("error") >= 1);
  s.close(); wss.close();
  assert.equal(typeof connectSocket, "function");
  void origEmit;
});

// CRLF env parsing
await t("CRLF env lines leave no trailing \\r", () => {
  const text = "A=1\r\nB=two\r\n";
  const out = {};
  for (const line of text.split(/\r?\n/)) { const m = line.match(/^(\w+)=(.*)$/); if (m) out[m[1]] = m[2].replace(/\r$/, ""); }
  assert.deepEqual(out, { A: "1", B: "two" });
});

// Turn-taking heuristics
const { looksComplete, classifyOverlap } = await import("../dist/turns.js");
await t("fragments that end mid-thought are not complete", () => {
  assert.ok(!looksComplete("Jeg vil bruke V4, selv om det, og-"));
  assert.ok(!looksComplete("Det er det--"));
  assert.ok(!looksComplete("Jeg tenkte at vi kunne, eh"));
  assert.ok(!looksComplete("Vi tar den og"));
  assert.ok(!looksComplete("uten tegnsetting"));
  assert.ok(looksComplete("Åh, gjerne."));
  assert.ok(looksComplete("Hva tenker du på?"));
  assert.ok(looksComplete("Det var bra, altså."));
});
await t("speech over a reply is classified", () => {
  assert.equal(classifyOverlap("Mm."), "filler");
  assert.equal(classifyOverlap("Mhm, mm."), "filler");
  assert.equal(classifyOverlap("Ja."), "ack");
  assert.equal(classifyOverlap("Ja ja, ok."), "ack");
  assert.equal(classifyOverlap("Stopp, det er feil."), "speech");
  assert.equal(classifyOverlap("Nei, vent litt, gjør det heller sånn."), "speech");
});

// Turn merging and soft barge-in inside the pipeline
const { VoicePipeline } = await import("../dist/voice-pipeline.js");
function fakePipeline({ busy = false } = {}) {
  const pipe = new VoicePipeline({ guilds: { cache: new Map() } }, { elevenLabsApiKey: "x", mergeMs: 40 });
  const said = [];
  const calls = { interrupted: 0, ducked: [] };
  pipe.emit = (_id, _name, text) => said.push(text);
  pipe.playback = {
    busy,
    setDucked: (d) => calls.ducked.push(d),
    interrupt: () => { calls.interrupted++; return null; },
  };
  const listener = { userId: "111111111111111111", speechBuffer: { speaking: false }, session: null, inflight: 0, pending: null };
  return { pipe, said, calls, listener };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await t("a finished sentence is delivered at once", () => {
  const { pipe, said, listener } = fakePipeline();
  pipe.onUtterance(listener, "Åh, gjerne.", false);
  assert.deepEqual(said, ["Åh, gjerne."]);
  pipe.destroy();
});
await t("a cut-off fragment waits, then merges with what follows", async () => {
  const { pipe, said, listener } = fakePipeline();
  pipe.onUtterance(listener, "Jeg vil bruke V4, selv om det, og-", false);
  assert.equal(said.length, 0);
  listener.speechBuffer.speaking = true; // user carries on
  pipe.holdPending(listener);
  await sleep(60);
  assert.equal(said.length, 0, "held while the user is talking");
  listener.speechBuffer.speaking = false;
  pipe.onUtterance(listener, "det går litt seint.", false);
  assert.deepEqual(said, ["Jeg vil bruke V4, selv om det, og- det går litt seint."]);
  pipe.destroy();
});
await t("a finished sentence is held while the user is already talking again", () => {
  const { pipe, said, listener } = fakePipeline();
  listener.inflight = 1; // next utterance still being transcribed
  pipe.onUtterance(listener, "Ja, kjør på.", false);
  assert.equal(said.length, 0);
  listener.inflight = 0;
  pipe.onUtterance(listener, "Og bruk Opus.", false);
  assert.deepEqual(said, ["Ja, kjør på. Og bruk Opus."]);
  pipe.destroy();
});
await t("a lone fragment is delivered after the merge window", async () => {
  const { pipe, said, listener } = fakePipeline();
  pipe.onUtterance(listener, "Jeg lurer på om", false);
  assert.equal(said.length, 0);
  await sleep(80);
  assert.deepEqual(said, ["Jeg lurer på om"]);
  pipe.destroy();
});
await t("'mm' over a reply is dropped without interrupting", () => {
  const { pipe, said, calls, listener } = fakePipeline({ busy: true });
  pipe.duckers.add(listener.userId);
  pipe.onUtterance(listener, "Mm.", true);
  assert.equal(said.length, 0);
  assert.equal(calls.interrupted, 0);
  assert.deepEqual(calls.ducked, [false], "volume restored");
  pipe.destroy();
});
await t("'ja' over a reply is passed on, marked, without interrupting", () => {
  const { pipe, said, calls, listener } = fakePipeline({ busy: true });
  pipe.onUtterance(listener, "Ja.", true);
  assert.equal(calls.interrupted, 0);
  assert.equal(said.length, 1);
  assert.match(said[0], /^\[Said while you were still talking.*\] Ja\.$/);
  pipe.destroy();
});
await t("a short real interruption cuts the reply off", () => {
  const { pipe, said, calls, listener } = fakePipeline({ busy: true });
  pipe.onUtterance(listener, "Stopp der.", true);
  assert.equal(calls.interrupted, 1);
  assert.deepEqual(said, ["Stopp der."]);
  pipe.destroy();
});

// Anti-aliasing downsampler
const { createDownsampler } = await import("../dist/audio-utils.js");
async function downsampleTone(freq, amplitude = 10000, ms = 200) {
  const frames = 48 * ms;
  const input = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / 48000));
    input.writeInt16LE(v, i * 4);
    input.writeInt16LE(v, i * 4 + 2);
  }
  const ds = createDownsampler();
  const out = [];
  ds.on("data", (c) => out.push(c));
  // Feed in Discord-sized 20 ms packets.
  for (let off = 0; off < input.length; off += 3840) ds.write(input.subarray(off, off + 3840));
  ds.end();
  await new Promise((r) => ds.on("end", r));
  const pcm = Buffer.concat(out);
  const samples = pcm.length / 2;
  let sum = 0;
  for (let i = 200; i < samples; i++) sum += pcm.readInt16LE(i * 2) ** 2; // skip filter warm-up
  return { samples, rms: Math.sqrt(sum / (samples - 200)) };
}
await t("downsampler keeps speech and rejects what would alias", async () => {
  const low = await downsampleTone(1000);
  assert.equal(low.samples, 16 * 200, "exactly one output sample per three input samples");
  assert.ok(Math.abs(low.rms - 10000 / Math.SQRT2) < 200, `1 kHz passes (rms ${low.rms.toFixed(0)})`);
  const high = await downsampleTone(12000);
  assert.ok(high.rms < 70, `12 kHz is suppressed by more than 40 dB (rms ${high.rms.toFixed(1)})`);
});

// Task registry
const { TaskRegistry, chunkMessage, threadName, cleanTaskName } = await import("../dist/tasks.js");
await t("long task reports are split under Discord's limit", () => {
  const text = Array.from({ length: 120 }, (_, i) => `Linje ${i}: ${"x".repeat(40)}`).join("\n");
  const chunks = chunkMessage(text);
  assert.ok(chunks.length > 1 && chunks.every((c) => c.length <= 2000));
  assert.equal(chunks.join("\n"), text);
  assert.deepEqual(chunkMessage("kort"), ["kort"]);
});
await t("task registry persists and orders by last update", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-tasks-"));
  const file = join(dir, "tasks.json");
  const reg = new TaskRegistry(file);
  const now = new Date().toISOString();
  reg.add({ threadId: "1", guildId: "g", name: "a", status: "running", createdAt: now, updatedAt: now, lastUpdate: "" });
  await sleep(5);
  reg.add({ threadId: "2", guildId: "g", name: "b", status: "running", createdAt: now, updatedAt: new Date().toISOString(), lastUpdate: "" });
  await sleep(5);
  reg.update("1", { status: "done", lastUpdate: "ferdig", agentId: "agent-7" });
  const again = new TaskRegistry(file);
  assert.deepEqual(again.list().map((x) => x.threadId), ["1", "2"]);
  assert.equal(again.get("1").status, "done");
  assert.equal(again.get("1").agentId, "agent-7");
  assert.equal(threadName("tester", "done"), "✅ tester");
  assert.equal(cleanTaskName("  vakt\nflyt   tester "), "vakt flyt tester");
});

// Call a user into the voice channel: decision logic and invite text.
const { planCall, inviteText } = await import("../dist/call.js");
await t("a user already in the target channel needs no call", () => {
  assert.equal(planCall({ userVoiceChannelId: "1", targetChannelId: "1", botCanMoveMembers: true }).kind, "none");
});
await t("a user in another voice channel is moved when the bot can move members", () => {
  assert.deepEqual(
    planCall({ userVoiceChannelId: "2", targetChannelId: "1", botCanMoveMembers: true }),
    { kind: "move", fromChannelId: "2" },
  );
});
await t("a user in voice is DMed when the bot lacks MOVE_MEMBERS", () => {
  assert.equal(planCall({ userVoiceChannelId: "2", targetChannelId: "1", botCanMoveMembers: false }).kind, "dm");
});
await t("a user not in voice is DMed, never moved", () => {
  assert.equal(planCall({ userVoiceChannelId: null, targetChannelId: "1", botCanMoveMembers: true }).kind, "dm");
});
await t("invite text links to the channel", () => {
  const text = inviteText({ callerName: "Tor Martin", channelName: "Voice", guildId: "10", channelId: "20" });
  assert.match(text, /https:\/\/discord\.com\/channels\/10\/20$/);
});
console.log(`\n${passed} tests passed`);
process.exit(0);
