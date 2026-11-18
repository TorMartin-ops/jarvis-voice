// Unit tests for the pure parts of jarvis-voice. Run with: npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SentenceSplitter, toSpeech } = await import("../dist/split.js");
const { WakeGate } = await import("../dist/gate.js");
const { checkTool, isInside, redact } = await import("../dist/policy.js");
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

// ---- policy -----------------------------------------------------------------
const root = "C:/Users/torma/work";
t("policy: destructive and outward commands are blocked", () => {
  for (const cmd of ["git push origin main", "Remove-Item C:/x -Recurse", "rm -rf build", "Send-MailMessage -To a", "curl -X POST https://x", "shutdown /s"]) {
    assert.match(checkTool("Bash", { command: cmd }, root) ?? "", /BLOCKED/, cmd);
  }
});
t("policy: ordinary commands are allowed", () => {
  for (const cmd of ["git status", "npm test", "Get-ChildItem", "dir"]) {
    assert.equal(checkTool("Bash", { command: cmd }, root), null, cmd);
  }
});
t("policy: writes stay inside the worker folder", () => {
  assert.equal(checkTool("Write", { file_path: "C:/Users/torma/work/a.txt" }, root), null);
  assert.equal(checkTool("Edit", { file_path: "notes.md" }, root), null);
  assert.match(checkTool("Write", { file_path: "C:/Windows/system.ini" }, root) ?? "", /BLOCKED/);
  assert.match(checkTool("Write", { file_path: "C:/Users/torma/work/../secret.txt" }, root) ?? "", /BLOCKED/);
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
  assert.ok(cfg.toolAllow.includes("Bash"));
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
