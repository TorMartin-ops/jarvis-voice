// Deterministic tests of the conversation loop with fake services (no network, no audio devices).
// Covers: the echo guard, backchannels, barge-in by a real request, tags carried to the next
// sentence, and announcements waiting for an idle moment.
import assert from "node:assert/strict";
const { Conversation } = await import("../dist/conversation.js");
const { WakeGate } = await import("../dist/gate.js");

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function setup(replies) {
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
  // One second of silence per sentence, so the speaker stays "busy" for a realistic time.
  async function* synth(text) {
    spokenTexts.push(text);
    yield Buffer.alloc(48000);
  }
  const conv = new Conversation({
    buffer: { feed: async () => [] },
    stt: { open: () => null, dispose() {} },
    brain,
    speaker,
    gate: new WakeGate(["jarvis"], 60_000),
    tts: { apiKey: "x", voice: "v", model: "m" },
    bargeInMs: 400,
    mergeMs: 0,
    audioMode: "speakers",
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

await t("a real request while it speaks cuts the reply and starts a new turn", async () => {
  const { conv, calls, speaker, brain } = setup(["Et svar som varer. Og fortsetter.", "Klokka er ti."]);
  conv["onUtterance"]("Jarvis, si noe langt.");
  await tick(60);
  conv["onUtterance"]("stopp, hva er klokka?");
  await tick(60);
  assert.equal(calls.length, 2);
  assert.equal(calls[1], "stopp, hva er klokka?");
  assert.ok(speaker.stops >= 1, "speech must be stopped");
  assert.ok(brain.notes.some((n) => /avbrutt/.test(n)), "Luna must learn she was interrupted");
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

console.log(`\n${passed} conversation tests passed`);
process.exit(0);
