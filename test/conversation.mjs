// Deterministic tests of the conversation loop with fake services (no network, no audio devices).
// Covers: the echo guard, backchannels, barge-in by a real request, half duplex on speakers,
// stop commands, tags carried to the next sentence, and announcements waiting for an idle moment.
import assert from "node:assert/strict";
const { Conversation, ECHO_TAIL_MS } = await import("../dist/conversation.js");
const { WakeGate } = await import("../dist/gate.js");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup(replies, { audioMode = "speakers", audioMs = 1000, stt = { open: () => null, dispose() {} } } = {}) {
  const calls = [];
  const spokenTexts = [];
  const speaker = {
    active: false,
    stops: 0,
    write() { this.active = true; },
    finish() { this.active = false; },
    stop() { this.active = false; this.stops++; },
  };
  const brain = {
    notes: [],
    note(t) { this.notes.push(t); },
    async respond(text, hooks, signal) {
      calls.push(text);
      const reply = replies.shift() ?? "Greit.";
      for (const part of reply.match(/[^.!?]+[.!?]+\s*/g) ?? [reply]) {
        if (signal?.aborted) throw new Error("aborted");
        hooks.onText(part);
        await tick(5);
      }
    },
  };
  // Silence per sentence (one second by default), so the speaker stays "busy" for a realistic time.
  async function* synth(text) {
    spokenTexts.push(text);
    yield Buffer.alloc(audioMs * 48);
  }
  const conv = new Conversation({
    buffer: { feed: async () => [] },
    stt,
    brain,
    speaker,
    gate: new WakeGate(["jarvis"], 60_000),
    tts: { apiKey: "x", voice: "v", model: "m" },
    bargeInMs: 400,
    mergeMs: 0,
    audioMode,
    synth,
    log: () => {},
  });
  return { conv, calls, spokenTexts, speaker, brain };
}

let passed = 0;
async function t(name, fn) {
  await fn();
  passed++;
  console.log("ok  " + name);
}

await t("echo of the assistant's own words is ignored while it speaks", async () => {
  const { conv, calls } = setup(["Her er en vits. Datamaskinen hadde fått virus."]);
  conv["onUtterance"]("Jarvis, fortell en vits.");
  await tick(80);
  assert.equal(calls.length, 1);
  conv["onUtterance"]("hadde fått virus");
  conv["onUtterance"]("Her er en vits");
  await tick(30);
  assert.equal(calls.length, 1, "echo must not start a new turn");
});

await t("backchannels while it speaks do not interrupt", async () => {
  const { conv, calls, speaker } = setup(["Dette er et lengre svar. Med to setninger."]);
  conv["onUtterance"]("Jarvis, forklar noe.");
  await tick(60);
  conv["onUtterance"]("mm");
  conv["onUtterance"]("ja ja");
  await tick(30);
  assert.equal(calls.length, 1);
  assert.equal(speaker.stops, 0);
});

await t("headset: a real request while it speaks cuts the reply and starts a new turn", async () => {
  const { conv, calls, speaker, brain } = setup(["Et svar som varer. Og fortsetter.", "Klokka er ti."], { audioMode: "headset" });
  conv["onUtterance"]("Jarvis, si noe langt.");
  await tick(60);
  conv["onUtterance"]("stopp, hva er klokka?");
  await tick(60);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "stopp, hva er klokka?");
  assert.ok(speaker.stops >= 1, "speech must be stopped");
  assert.ok(brain.notes.some((n) => /avbrutt/.test(n)), "Luna must learn she was interrupted");
});

await t("half duplex: talk without the name while it speaks is ignored, even when it is no echo", async () => {
  const { conv, calls, speaker } = setup(["Et svar som varer. Og fortsetter."]);
  conv["onUtterance"]("Jarvis, si noe langt.");
  await tick(60);
  conv["onUtterance"]("Det var din dame, ikke min.");
  conv["onUtterance"]("Det var tolv.");
  await tick(30);
  assert.equal(calls.length, 1, "speech over the reply without the name must not start a turn");
  assert.equal(speaker.stops, 0, "speech over the reply without the name must not cut it");
});

await t("half duplex: the name while it speaks cuts the reply and starts a new turn", async () => {
  const { conv, calls, speaker, brain } = setup(["Et svar som varer. Og fortsetter.", "Klokka er ti."]);
  conv["onUtterance"]("Jarvis, si noe langt.");
  await tick(60);
  conv["onUtterance"]("Jarvis, hva er klokka?");
  await tick(60);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "hva er klokka?");
  assert.ok(speaker.stops >= 1, "speech must be stopped");
  assert.ok(brain.notes.some((n) => /avbrutt/.test(n)), "Luna must learn she was interrupted");
});

await t("half duplex: its own name coming back through the mic does not cut the reply", async () => {
  const { conv, calls, speaker } = setup(["Jarvis her, til tjeneste. Dette tar litt tid."]);
  conv["onUtterance"]("Jarvis, hvem er du?");
  await tick(60);
  conv["onUtterance"]("Jarvis, det er kaffe her da."); // a misheard echo: too different for the echo guard
  await tick(30);
  assert.equal(calls.length, 1, "the assistant's own name must not open a new turn");
  assert.equal(speaker.stops, 0, "the assistant's own name must not cut the reply");
});

await t("'Jarvis, stopp' silences the reply at once and starts no new turn", async () => {
  const { conv, calls, speaker } = setup(["Et svar som varer. Og fortsetter."]);
  conv["onUtterance"]("Jarvis, si noe langt.");
  await tick(60);
  conv["onUtterance"]("Jarvis, stopp.");
  await tick(60);
  assert.ok(speaker.stops >= 1, "the reply must stop");
  assert.equal(calls.length, 1, "a stop command must not start a new turn");
  assert.equal(conv.state, "listening");
});

await t("half duplex: speech that runs on past the reply is cut where the reply ended", async () => {
  const sessions = [];
  const stt = {
    open() {
      const s = { writes: [], cancelled: false, write(a) { this.writes.push(String(a)); }, cancel() { this.cancelled = true; }, async commit() { return "hva er klokka nå?"; } };
      sessions.push(s);
      return s;
    },
    dispose() {},
  };
  const { conv, calls } = setup(["Hei."], { stt, audioMs: 100 });
  conv["onUtterance"]("Jarvis, si hei.");
  await tick(30);
  assert.equal(conv.state, "speaking");
  conv["onSpeech"]({ type: "start", audio: Buffer.from("echo") });
  conv["onSpeech"]({ type: "audio", audio: Buffer.from("echo"), speech: true });
  await tick(100 + ECHO_TAIL_MS + 100);
  conv["onSpeech"]({ type: "audio", audio: Buffer.from("user"), speech: true });
  conv["onSpeech"]({ type: "end", discard: false });
  await tick(30);
  assert.equal(sessions.length, 2, "a fresh transcription must start where the reply ended");
  assert.ok(sessions[0].cancelled, "what was heard over the reply must be dropped");
  assert.deepEqual(sessions[1].writes, ["user"], "only speech after the reply is transcribed");
  assert.deepEqual(calls, ["si hei.", "hva er klokka nå?"]);
});

await t("a greeting does not open the conversation window", async () => {
  const { conv, calls } = setup(["God morgen."], { audioMode: "headset", audioMs: 50 });
  conv.greet();
  await tick(300);
  conv["onUtterance"]("Da må jeg ned i bilen.");
  await tick(30);
  assert.equal(calls.length, 1, "talk after the greeting without the name must not reach Luna");
  assert.equal(calls[0], null, "the greeting is a report turn");
});

await t("a tag sent as its own sentence is carried to the next sentence", async () => {
  const { conv, spokenTexts } = setup(["Den var god. [laughs]\nJeg ler fortsatt."]);
  conv["onUtterance"]("Jarvis, var den morsom?");
  await tick(80);
  assert.deepEqual(spokenTexts, ["Den var god.", "[laughs] Jeg ler fortsatt."]);
});

await t("an announcement waits until the assistant is idle, then is spoken", async () => {
  const { conv, calls, speaker } = setup(["Første svar.", "Oppgaven er ferdig."]);
  conv["onUtterance"]("Jarvis, start noe.");
  await tick(20);
  conv.announce("[Oppgave ferdig] test");
  assert.equal(calls.length, 1, "must not talk over the current reply");
  speaker.finish();
  await tick(1700); // the first reply's audio (1 s) must finish playing first
  assert.equal(calls.length, 2);
  assert.equal(calls[1], null, "report turn has no user text");
});

// ---- Brain with a fake Azure stream: the turn policy saves a model round trip ----
const { Brain } = await import("../dist/brain.js");
const { afterTools } = await import("../dist/luna-tools.js");
function sse(chunks) {
  const body = chunks.map((c) => "data: " + JSON.stringify({ choices: [c] }) + "\n\n").join("") + "data: [DONE]\n\n";
  return new Response(new Blob([body]).stream(), { status: 200 });
}
function fakeBrain(runTool) {
  return new Brain({
    endpoint: "https://example.invalid", apiKey: "x", deployment: "d", apiVersion: "v",
    context: () => "", runTool, afterTools,
  });
}
await t("brain: a tool-only start_task step is acknowledged locally with no second model call", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return sse([
      { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "start_task", arguments: '{"title":"Tell filer","description":"Tell .ts-filer"}' } }] } },
      { delta: {}, finish_reason: "tool_calls" },
    ]);
  };
  try {
    let heard = "";
    await fakeBrain(() => 'Started task t1 ("Tell filer").').respond("Jarvis, tell filene.", { onText: (c) => (heard += c) });
    assert.equal(n, 1, "no second model step");
    assert.ok(heard.trim().length > 3, "an acknowledgement was spoken");
  } finally {
    globalThis.fetch = realFetch;
  }
});
await t("brain: a blocked action after a confirmation question ends the turn without an apology", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return sse([
      { delta: { content: "Skal jeg sende den? Svar «ja, send»." } },
      { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "start_task", arguments: '{"title":"Send","description":"d","confirmed_action":"x"}' } }] } },
      { delta: {}, finish_reason: "tool_calls" },
    ]);
  };
  try {
    let heard = "";
    await fakeBrain(() => "BLOCKED: no confirmation.").respond("send en e-post", { onText: (c) => (heard += c) });
    assert.equal(n, 1);
    assert.equal(heard.trim(), "Skal jeg sende den? Svar «ja, send».");
  } finally {
    globalThis.fetch = realFetch;
  }
});
await t("brain: list_tasks still gets a second step so the result is read out", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    return n === 1
      ? sse([
          { delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "list_tasks", arguments: "{}" } }] } },
          { delta: {}, finish_reason: "tool_calls" },
        ])
      : sse([{ delta: { content: "Én oppgave kjører." } }, { delta: {}, finish_reason: "stop" }]);
  };
  try {
    let heard = "";
    await fakeBrain(() => "t1: Tell filer - kjører").respond("hva skjer?", { onText: (c) => (heard += c) });
    assert.equal(n, 2);
    assert.equal(heard.trim(), "Én oppgave kjører.");
  } finally {
    globalThis.fetch = realFetch;
  }
});

const connectionError = () => new TypeError("fetch failed", { cause: { code: "ECONNRESET", message: "other side closed" } });
await t("brain: a failed connection is tried once more, and the reply still comes", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    if (n === 1) throw connectionError();
    return sse([{ delta: { content: "God morgen." } }, { delta: {}, finish_reason: "stop" }]);
  };
  try {
    let heard = "";
    await fakeBrain(() => "").respond(null, { onText: (c) => (heard += c) });
    assert.equal(n, 2, "one retry after the connection failed");
    assert.equal(heard.trim(), "God morgen.");
  } finally {
    globalThis.fetch = realFetch;
  }
});
await t("brain: a connection that fails twice gives up with the cause; HTTP errors are not retried", async () => {
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n++;
    throw connectionError();
  };
  try {
    await assert.rejects(fakeBrain(() => "").respond("hei", { onText() {} }), /fetch failed twice \(ECONNRESET other side closed\)/);
    assert.equal(n, 2, "exactly one retry");
    n = 0;
    globalThis.fetch = async () => {
      n++;
      return new Response("nope", { status: 401 });
    };
    await assert.rejects(fakeBrain(() => "").respond("hei", { onText() {} }), /Azure OpenAI 401/);
    assert.equal(n, 1, "an HTTP error is an answer, not a connection failure");
  } finally {
    globalThis.fetch = realFetch;
  }
});

console.log(`\n${passed} conversation tests passed`);
process.exit(0);
