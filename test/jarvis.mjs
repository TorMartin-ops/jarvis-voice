// Tests for the new pieces: sentence splitting and worker result summaries.
import assert from "node:assert/strict";
const { SentenceSplitter } = await import("../dist/split.js");
const { summarize } = await import("../dist/worker.js");
const { parseReply } = await import("../dist/brain-cli.js");

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("ok  " + name); };

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
t("flush returns nothing when empty", () => {
  assert.deepEqual(new SentenceSplitter().flush(), []);
});
t("summary keeps the first sentences and marks failure", () => {
  assert.equal(summarize("Ferdig. Testene gikk. Alt er grønt. Fjerde setning.", 0), "Ferdig. Testene gikk. Alt er grønt.");
  assert.match(summarize("Noe gikk galt.", 1), /feilet/);
});
t("long output is capped", () => {
  const long = "Ord er fint. ".repeat(200);
  assert.ok(summarize(long, 0).length <= 510);
});

t("CLI brain splits speech from delegation lines", () => {
  const r = parseReply("Skal bli, jeg setter i gang.\nDELEGATE: Finn alle TODO i repoet og oppsummer.\n\n**Ferdig** snart.");
  assert.deepEqual(r.speech, ["Skal bli, jeg setter i gang.", "Ferdig snart."]);
  assert.deepEqual(r.delegations, ["Finn alle TODO i repoet og oppsummer."]);
});
t("CLI brain ignores an empty delegation", () => {
  assert.deepEqual(parseReply("DELEGATE:   \nHei").delegations, []);
});

console.log(`\n${passed} jarvis tests passed`);
