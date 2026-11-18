// Tests of the microphone watchdog with fake ffmpeg processes (no audio devices, no network).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
const { startMic, peakLevel } = await import("../dist/mic.js");

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

function fakeSpawner() {
  const procs = [];
  const spawnFn = () => {
    const p = new EventEmitter();
    p.stdout = new EventEmitter();
    p.stderr = new EventEmitter();
    p.killed = false;
    p.kill = () => {
      p.killed = true;
      setImmediate(() => p.emit("exit", null));
    };
    procs.push(p);
    return p;
  };
  return { procs, spawnFn };
}

const loud = () => {
  const b = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) b.writeInt16LE(i % 2 ? 3000 : -3000, i * 2);
  return b;
};
const zeros = () => Buffer.alloc(320);

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log("ok  " + name);
}

await t("peak level: zeros are silence, speech is not", async () => {
  assert.equal(peakLevel(zeros()), 0);
  assert.equal(peakLevel(loud()), 3000);
});

await t("a stalled capture (no audio at all) is restarted", async () => {
  const { procs, spawnFn } = fakeSpawner();
  const logs = [];
  const mic = startMic("Mic", () => {}, (m) => logs.push(m), { spawnFn, stallMs: 100, silenceMs: 10_000 });
  await tick(500);
  mic.stop();
  assert.ok(procs.length >= 2, `expected a restart, got ${procs.length} process(es)`);
  assert.ok(procs[0].killed);
  assert.ok(logs.some((l) => /no audio/.test(l)), logs.join(" | "));
});

await t("a capture that exits (headset unplugged) is retried until it is back", async () => {
  const { procs, spawnFn } = fakeSpawner();
  const logs = [];
  const chunks = [];
  const mic = startMic("Mic", (c) => chunks.push(c), (m) => logs.push(m), { spawnFn, stallMs: 5_000, silenceMs: 10_000, maxBackoffMs: 50 });
  procs[0].emit("exit", 1);
  await tick(700);
  assert.ok(procs.length >= 2, "retried");
  procs.at(-1).stdout.emit("data", loud());
  mic.stop();
  assert.equal(chunks.length, 1, "audio flows again from the new process");
  assert.ok(logs.some((l) => /retrying/.test(l)));
  assert.ok(logs.some((l) => /back/.test(l)));
  assert.equal(logs.filter((l) => /capture stopped/.test(l)).length, 1, "the failure is logged once, not on every retry");
});

await t("long pure silence (muted or stale headset) warns once and restarts capture", async () => {
  const { procs, spawnFn } = fakeSpawner();
  const logs = [];
  const mic = startMic("Mic", () => {}, (m) => logs.push(m), { spawnFn, stallMs: 5_000, silenceMs: 150 });
  const feed = setInterval(() => procs.at(-1)?.stdout.emit("data", zeros()), 20);
  await tick(600);
  clearInterval(feed);
  mic.stop();
  assert.ok(procs.length >= 2, "restarted");
  assert.equal(logs.filter((l) => /pure silence/.test(l)).length, 1, logs.join(" | "));
});

await t("normal speech is passed through and never restarts capture", async () => {
  const { procs, spawnFn } = fakeSpawner();
  const chunks = [];
  const mic = startMic("Mic", (c) => chunks.push(c), () => {}, { spawnFn, stallMs: 200, silenceMs: 200 });
  const feed = setInterval(() => procs[0].stdout.emit("data", loud()), 20);
  await tick(600);
  clearInterval(feed);
  mic.stop();
  assert.equal(procs.length, 1);
  assert.ok(chunks.length > 10);
});

await t("stop ends capture and no restart follows", async () => {
  const { procs, spawnFn } = fakeSpawner();
  const mic = startMic("Mic", () => {}, () => {}, { spawnFn, stallMs: 50, silenceMs: 50, maxBackoffMs: 20 });
  mic.stop();
  await tick(300);
  assert.equal(procs.length, 1);
  assert.ok(procs[0].killed);
});

await t("voice detector: large chunks from ffmpeg are analysed, not thrown away", async () => {
  const { SpeechBuffer } = await import("../dist/audio-utils.js");
  const buf = await SpeechBuffer.create();
  // One second of quiet room noise in a single 32 KB chunk (Windows ffmpeg delivers about 16 KB at a time).
  const chunk = Buffer.alloc(32000);
  for (let i = 0; i < 16000; i++) chunk.writeInt16LE(Math.round((Math.random() - 0.5) * 400), i * 2);
  await buf.feed(chunk);
  assert.ok(buf.preRollBufferedMs > 0, "frames reached the voice detector");
  assert.ok(buf.frameAccumulator.length < 1024, "only a partial frame is left over");
});

console.log(`\n${passed} microphone tests passed`);
process.exit(0);
