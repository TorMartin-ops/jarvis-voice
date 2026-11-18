// Unit tests for the pure parts of jarvis-voice. Run with: npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SentenceSplitter, toSpeech } = await import("../dist/split.js");
const { WakeGate } = await import("../dist/gate.js");
const { isInside, redact } = await import("../dist/policy.js");
const { parseWorkerEvent, WORKER_DISALLOWED } = await import("../dist/tasks.js");
const { Memory } = await import("../dist/memory.js");
const { runLunaTool, finishNote } = await import("../dist/luna-tools.js");
const { parseSseLine } = await import("../dist/brain.js");
const { loadConfig, loadDotEnv, ConfigError } = await import("../dist/config.js");

let passed = 0;
const t = (name, fn) => {
  fn();
  passed++;
  console.log("ok  " + name);
};

// ---- sentence splitting and speech text -----------------------------------
t("streamed text splits at sentence ends", () => {
  const s = new SentenceSplitter();
  const out = [...s.push("Hei der. Jeg"), ...s.push(" har det bra! Og du?"), ...s.flush()];
  assert.deepEqual(out, ["Hei der.", "Jeg har det bra!", "Og du?"]);
});
t("a sentence end without a following space waits for more text", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Versjon 3."), []);
  assert.deepEqual(s.push(" Ferdig."), ["Versjon 3."]);
  assert.deepEqual(s.flush(), ["Ferdig."]);
});
t("newlines end a sentence", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Første linje\nAndre"), ["Første linje"]);
  assert.deepEqual(s.flush(), ["Andre"]);
});
t("markdown is removed before speech", () => {
  assert.equal(toSpeech("Jeg er i mappen `C:/Users/torma/x`. **Ferdig** nå."), "Jeg er i mappen C:/Users/torma/x. Ferdig nå.");
  assert.equal(toSpeech("- ett\n- to"), "ett to");
  assert.equal(toSpeech("[lenke](https://x.no) her"), "lenke her");
});

// ---- wake word gate ---------------------------------------------------------
t("gate: a name opens the window, later speech passes until it closes", () => {
  let now = 0;
  const g = new WakeGate(["claude"], 1000, () => now);
  assert.equal(g.admit("hva skjer?"), false);
  assert.equal(g.admit("Claude, hei"), true);
  now = 900;
  assert.equal(g.admit("og hva med dette"), true);
  now = 5000;
  assert.equal(g.admit("noen andre snakker"), false);
});
t("gate: matches whole words only and common mishearings", () => {
  const g = new WakeGate(["claude", "klod"], 1000, () => 0);
  assert.equal(g.admit("clauden er fin"), false);
  assert.equal(g.admit("Klod, test"), true);
  assert.equal(g.admit("hei claude!"), true);
});
t("gate: strip removes the wake word and keeps the request", () => {
  const g = new WakeGate(["claude"], 1000, () => 0);
  assert.equal(g.strip("Claude, hvilken mappe er du i?"), "hvilken mappe er du i?");
  assert.equal(g.strip("Claude."), "");
  assert.equal(g.strip("hei Claude og test"), "hei og test");
});
t("gate: no words configured means everything is admitted", () => {
  assert.equal(new WakeGate([], 1000).admit("alt"), true);
});

// ---- workers, Luna's tools, memory ------------------------------------------
const root = "C:/Users/torma/work";
t("workers may never push, delete recursively or send mail", () => {
  for (const rule of ["Bash(git push:*)", "Bash(rm -rf:*)", "PowerShell(Send-MailMessage:*)"]) assert.ok(WORKER_DISALLOWED.includes(rule), rule);
});
t("worker stream: tool use, text and final result are parsed", () => {
  const a = parseWorkerEvent(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "ok" }] } }));
  assert.deepEqual(a, [{ kind: "tool", name: "Bash" }, { kind: "text", text: "ok" }]);
  const r = parseWorkerEvent(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Ferdig.", total_cost_usd: 0.01 }));
  assert.deepEqual(r, [{ kind: "result", ok: true, text: "Ferdig.", costUsd: 0.01 }]);
  assert.deepEqual(parseWorkerEvent("not json"), []);
});
t("Luna's tools: start, list, cancel, remember, forget", () => {
  const started = [];
  const deps = {
    tasks: {
      start: (title, description, confirmed) => { const task = { id: "t1", title, description, confirmedAction: confirmed, status: "running", startedAt: "x", progress: "steg 1: Bash", steps: 1 }; started.push(task); return task; },
      list: () => started,
      cancel: (id) => id === "t1",
    },
    memory: { add: (x) => x === "kaffe uten melk", forget: (p) => (p === "kaffe" ? 1 : 0) },
  };
  assert.match(runLunaTool(deps, "start_task", { title: "Test", description: "Gjør noe" }), /Started task t1/);
  assert.equal(started[0].confirmedAction, undefined);
  assert.match(runLunaTool(deps, "start_task", { title: "x" }), /ERROR/);
  assert.ok(runLunaTool(deps, "list_tasks", {}).includes("t1: Test - kjører (steg 1: Bash)"));
  assert.equal(runLunaTool(deps, "cancel_task", { id: "t1" }), "Cancelled.");
  assert.equal(runLunaTool(deps, "remember", { fact: "kaffe uten melk" }), "Saved.");
  assert.match(runLunaTool(deps, "forget", { phrase: "kaffe" }), /Forgot 1/);
  assert.match(runLunaTool(deps, "nope", {}), /unknown tool/);
});
t("finish note tells Luna the status and result", () => {
  assert.equal(finishNote({ id: "t1", title: "Test", status: "done", result: "Alt ok.", description: "", startedAt: "", progress: "", steps: 0 }), '[Oppgave ferdig] "Test" (t1) er ferdig. Resultat: Alt ok.');
});
t("memory: dedupes, forgets, persists, renders", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-mem-"));
  const m = new Memory(join(dir, "memory.json"));
  assert.equal(m.add("Liker kaffe svart"), true);
  assert.equal(m.add("liker kaffe svart"), false);
  assert.match(m.render(), /Liker kaffe svart/);
  assert.equal(new Memory(join(dir, "memory.json")).list().length, 1);
  assert.equal(m.forget("kaffe"), 1);
  assert.equal(m.render(), "");
});
t("isInside rejects prefix tricks and traversal", () => {
  assert.equal(isInside("C:/Users/torma/work-evil/x", root), false);
  assert.equal(isInside("C:/Users/torma/work/sub/x", root), true);
});
t("redact removes keys and tokens", () => {
  assert.equal(redact("key sk-abcdef123456789 here"), "key sk-[redacted] here");
  assert.equal(redact("api_key=abc123def"), "api_key=[redacted]");
});

// ---- SSE parsing --------------------------------------------------------------
t("SSE: data lines parse, control lines are ignored", () => {
  assert.equal(parseSseLine("data: [DONE]"), null);
  assert.equal(parseSseLine(": keep-alive"), null);
  assert.deepEqual(parseSseLine('data: {"a":1}'), { a: 1 });
});

// ---- config -------------------------------------------------------------------
t("config: missing required settings are listed", () => {
  assert.throws(() => loadConfig({}), (e) => e instanceof ConfigError && /ELEVENLABS_API_KEY/.test(e.message) && /JARVIS_MIC/.test(e.message));
});
t("config: defaults and parsing", () => {
  const cfg = loadConfig({
    ELEVENLABS_API_KEY: "e",
    AZURE_OPENAI_ENDPOINT: "https://x.openai.azure.com/",
    AZURE_OPENAI_API_KEY: "k",
    AZURE_OPENAI_DEPLOYMENT: "d",
    JARVIS_MIC: "Mikrofon",
    USERPROFILE: "C:/Users/torma",
  });
  assert.equal(cfg.bargeInMs, 400);
  assert.equal(cfg.wakeWindowMs, 90000);
  assert.equal(cfg.taskTimeoutMs, 1800000);
  assert.ok(cfg.wakeWords.includes("luna"));
  assert.throws(() => loadConfig({ ...process.env, ELEVENLABS_API_KEY: "e", JARVIS_BARGE_IN_MS: "-1", AZURE_OPENAI_ENDPOINT: "x", AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_DEPLOYMENT: "d", JARVIS_MIC: "m" }), ConfigError);
});
t("config: .env loads without overriding real environment", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-"));
  const file = join(dir, ".env");
  writeFileSync(file, "# comment\nA_KEY=from-file\nKEEP=file\n");
  const env = { KEEP: "real" };
  loadDotEnv(file, env);
  assert.equal(env.A_KEY, "from-file");
  assert.equal(env.KEEP, "real");
});

console.log(`\n${passed} tests passed`);
