// Unit tests for the pure parts of jarvis-voice. Run with: npm test
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { SentenceSplitter, toSpeech, sanitizeTags, stripTags, speakStandards } = await import("../dist/split.js");
const { isEcho, isBackchannel, isStopCommand, overlap } = await import("../dist/echo.js");
const { WakeGate } = await import("../dist/gate.js");
const { isInside, redact } = await import("../dist/policy.js");
const { parseWorkerEvent, WORKER_DISALLOWED, statusLine, questionIn } = await import("../dist/tasks.js");
const { Memory } = await import("../dist/memory.js");
const { runLunaTool, finishNote, isConfirmation, confirmationGate, afterTools, taskBoard, updateNote } = await import("../dist/luna-tools.js");
const { StudyPacks, studyInstructions, splitFrontMatter } = await import("../dist/study.js");
const { parseSseLine, reasoningHeadroom } = await import("../dist/brain.js");
const { loadConfig, loadDotEnv, ConfigError } = await import("../dist/config.js");
const { micInputArgs, listDeviceArgs, parseDeviceList, ffmpegBinary } = await import("../dist/mic.js");

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
t("gate: names lists the wake words said, so the assistant's own can be told apart", () => {
  const g = new WakeGate(["jarvis", "claude"], 1000, () => 0);
  assert.deepEqual(g.names("Jarvis, be Claude se på det"), ["jarvis", "claude"]);
  assert.deepEqual(g.names("hva er klokka"), []);
  assert.deepEqual(new WakeGate([], 1000).names("Jarvis"), []);
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
    lastUserText: () => "",
    previousReply: () => "",
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
  assert.throws(() => loadConfig({}, "win32"), (e) => e instanceof ConfigError && /ELEVENLABS_API_KEY/.test(e.message) && /JARVIS_MIC/.test(e.message));
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
  const base = { ELEVENLABS_API_KEY: "e", AZURE_OPENAI_ENDPOINT: "x", AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_DEPLOYMENT: "d", JARVIS_MIC: "m" };
  assert.equal(loadConfig({ ...base, JARVIS_AUDIO_MODE: "speakers" }).wakeWindowMs, 30000, "speakers default to a shorter window");
  assert.equal(loadConfig({ ...base, JARVIS_AUDIO_MODE: "speakers", JARVIS_WAKE_WINDOW_MS: "60000" }).wakeWindowMs, 60000);
  assert.ok(cfg.wakeWords.includes("luna"));
  assert.throws(() => loadConfig({ ...process.env, ELEVENLABS_API_KEY: "e", JARVIS_BARGE_IN_MS: "-1", AZURE_OPENAI_ENDPOINT: "x", AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_DEPLOYMENT: "d", JARVIS_MIC: "m" }), ConfigError);
});
t("config: Luna's reasoning effort and the TTS language are opt-in", () => {
  const base = { ELEVENLABS_API_KEY: "e", AZURE_OPENAI_ENDPOINT: "x", AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_DEPLOYMENT: "d", JARVIS_MIC: "m" };
  const plain = loadConfig(base);
  assert.equal(plain.azure.reasoningEffort, "none", "voice stays fast unless asked otherwise");
  assert.equal(plain.ttsLanguage, undefined, "no language_code by default: eleven_v4_turbo rejects it");
  const tuned = loadConfig({ ...base, JARVIS_REASONING_EFFORT: "medium", ELEVENLABS_TTS_LANGUAGE: "no" });
  assert.equal(tuned.azure.reasoningEffort, "medium");
  assert.equal(tuned.ttsLanguage, "no");
  assert.throws(() => loadConfig({ ...base, JARVIS_REASONING_EFFORT: "middels" }), (e) => e instanceof ConfigError && /JARVIS_REASONING_EFFORT/.test(e.message));
  assert.equal(reasoningHeadroom("none"), 0, "no thinking, no extra tokens");
  assert.ok(reasoningHeadroom("medium") >= 2000, "thinking must not eat the spoken answer's 500 tokens");
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

// ---- confirmation gate for outward actions ----------------------------------------
t("confirmation: explicit go-aheads pass, vague or negative answers do not", () => {
  for (const yes of ["Ja, send.", "send den", "Ja, gjør det", "kjør på", "bekreftet", "Ja, sen."]) assert.equal(isConfirmation(yes), true, yes);
  for (const no of ["ja", "ok", "nei, ikke send", "vent litt", "stopp"]) assert.equal(isConfirmation(no), false, no);
});
t("confirmation gate: the request itself, a vague yes, or a report turn never confirm", () => {
  const asked = "Jeg sender «Møtet er flyttet» til a@b.no. Si «ja, send» for å bekrefte.";
  assert.equal(confirmationGate("Ja, send.", asked), true);
  assert.equal(confirmationGate("send en e-post til a@b.no og si at møtet er flyttet", ""), false, "request in the same turn");
  assert.equal(confirmationGate("Ja, send.", "Det er gjort."), false, "nothing was read back first");
  assert.equal(confirmationGate("ja", asked), false, "a bare yes is not enough");
  assert.equal(confirmationGate("", asked), false, "report turns cannot confirm");
});
t("start_task with confirmed_action is blocked unless the gate passes", () => {
  const started = [];
  const deps = (said, before) => ({
    tasks: { start: (t, d, c) => (started.push(c), { id: "t9", title: t, description: d, status: "running", startedAt: "", progress: "", steps: 0 }), list: () => [], cancel: () => false },
    memory: { add: () => true, forget: () => 0 },
    lastUserText: () => said,
    previousReply: () => before,
  });
  const args = { title: "Send e-post", description: "Send møteendring", confirmed_action: "Send til a@b.no: Møtet er flyttet." };
  assert.match(runLunaTool(deps("send en e-post til a@b.no om møtet", ""), "start_task", args), /BLOCKED/);
  assert.equal(started.length, 0);
  assert.match(runLunaTool(deps("Ja, send.", "Skal jeg sende den? Si «ja, send»."), "start_task", args), /Started task/);
  assert.equal(started.length, 1);
});

// ---- audio tags, echo guard, backchannels ----------------------------------------
t("tags: supported tags are kept, aliases normalized, unknown tags removed", () => {
  assert.equal(sanitizeTags("[laughs] Selvsagt."), "[laughs] Selvsagt.");
  assert.equal(sanitizeTags("[giggles] Ja."), "[laughs] Ja.");
  assert.equal(sanitizeTags("[dramatic thunder] Hei."), "Hei.");
  assert.equal(sanitizeTags("[sighs] Nei. [laughs] Jo."), "[sighs] Nei. Jo.");
  assert.equal(stripTags("[sighs] Det feilet."), "Det feilet.");
});
t("echo: the assistant's own sentence heard back is recognized", () => {
  const spoken = ["Jeg har satt i gang en oppgave som teller filene.", "Det tar et minutt."];
  assert.equal(isEcho("jeg har satt i gang en oppgave som teller filene", spoken), true);
  assert.equal(isEcho("Jarvis, stopp, jeg mente noe annet", spoken), false);
  assert.ok(overlap("det tar et minutt", spoken.join(" ")) === 1);
});
t("backchannels are recognized, real requests are not", () => {
  for (const b of ["mm", "Ja.", "okei, skjønner", "Mhm", "jepp"]) assert.equal(isBackchannel(b), true, b);
  for (const r of ["ja, send den", "stopp", "hva er klokka"]) assert.equal(isBackchannel(r), false, r);
});
t("stop commands are recognized, requests that start with stop are not", () => {
  for (const s of ["stopp", "Stopp!", "stopp, stopp", "Hysj.", "ti stille", "det holder"]) assert.equal(isStopCommand(s), true, s);
  for (const r of ["stopp, hva er klokka?", "stopp oppgaven", "", "ja"]) assert.equal(isStopCommand(r), false, r);
});

// ---- turn policy after tools ------------------------------------------------------
t("after tools: a started task lets Luna speak in her own words (no canned acknowledgement)", () => {
  const r = afterTools([{ name: "start_task", result: 'Started task t1 ("x").' }], "");
  assert.equal(r.say, undefined);
  assert.equal(r.stop, false);
  assert.equal(afterTools([{ name: "start_task", result: 'Started task t1 ("x").' }], "Jeg setter en agent på det.").stop, false);
});
t("after tools: success after speech ends the turn; list_tasks and failures continue", () => {
  assert.equal(afterTools([{ name: "remember", result: "Saved." }], "Notert.").stop, true);
  assert.equal(afterTools([{ name: "list_tasks", result: "t1: x - kjører" }], "").stop, false);
  assert.equal(afterTools([{ name: "list_tasks", result: "t1: x - kjører" }], "La meg se.").stop, false);
  assert.equal(afterTools([{ name: "cancel_task", result: "No running task with that id." }], "Stopper den.").stop, false);
  assert.equal(afterTools([{ name: "start_task", result: "ERROR: description is required." }], "").stop, false);
});
t("after tools: a block right after asking ends the turn quietly; a block without a question continues", () => {
  const blocked = [{ name: "start_task", result: "BLOCKED: confirmed_action ..." }];
  assert.equal(afterTools(blocked, "Skal jeg sende den? Svar «ja, send».").stop, true);
  assert.equal(afterTools(blocked, "Skal bli, jeg sender den.").stop, false, "must correct a wrong promise");
  assert.equal(afterTools(blocked, "").stop, false);
});
t("speech: e-mail addresses are spoken the Norwegian way", () => {
  assert.equal(toSpeech("Send til test@example.com nå."), "Send til test krøllalfa example punktum com nå.");
});

// ---- macOS and Windows ------------------------------------------------------------
t("mic: Windows uses DirectShow, macOS uses AVFoundation audio-only input", () => {
  assert.deepEqual(micInputArgs("Mikrofon (HyperX)", "win32"), ["-f", "dshow", "-audio_buffer_size", "50", "-i", "audio=Mikrofon (HyperX)"]);
  assert.deepEqual(micInputArgs("MacBook Pro Microphone", "darwin"), ["-f", "avfoundation", "-i", ":MacBook Pro Microphone"]);
  assert.deepEqual(micInputArgs("", "darwin"), ["-f", "avfoundation", "-i", ":default"]);
  assert.throws(() => micInputArgs("x", "linux"), /not supported on linux/);
  assert.ok(listDeviceArgs("darwin").includes("avfoundation"));
  assert.ok(listDeviceArgs("win32").includes("dshow"));
});
t("mic: device lists parse on both platforms", () => {
  const mac = [
    "[AVFoundation indev @ 0x7f8] AVFoundation video devices:",
    "[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera",
    "[AVFoundation indev @ 0x7f8] [1] Capture screen 0",
    "[AVFoundation indev @ 0x7f8] AVFoundation audio devices:",
    "[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone",
    "[AVFoundation indev @ 0x7f8] [1] AirPods Pro",
    ": Input/output error",
  ].join("\n");
  assert.deepEqual(parseDeviceList(mac, "darwin"), ["MacBook Pro Microphone", "AirPods Pro"]);
  const win = '[dshow @ 0x1] "HD Webcam" (video)\n[dshow @ 0x1] "Mikrofon (HyperX Cloud II Wireless)" (audio)\n[dshow @ 0x1]   Alternative name "@device_cm_x"';
  assert.deepEqual(parseDeviceList(win, "win32"), ["Mikrofon (HyperX Cloud II Wireless)"]);
  assert.equal(ffmpegBinary({ JARVIS_FFMPEG: "/opt/homebrew/bin/ffmpeg" }), "/opt/homebrew/bin/ffmpeg");
});
t("config: macOS defaults to the system microphone, home folder and claude on PATH", () => {
  const base = { ELEVENLABS_API_KEY: "e", AZURE_OPENAI_ENDPOINT: "https://x/", AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_DEPLOYMENT: "d" };
  const mac = loadConfig({ ...base, HOME: "/Users/tm-test-nonexistent" }, "darwin");
  assert.equal(mac.micDevice, "default");
  assert.equal(mac.dataDir.replace(/\\/g, "/"), "/Users/tm-test-nonexistent/.jarvis");
  assert.equal(mac.workerCwd, "/Users/tm-test-nonexistent");
  assert.equal(mac.claudeBin, "claude");
  assert.throws(() => loadConfig(base, "win32"), (e) => e instanceof ConfigError && /JARVIS_MIC/.test(e.message), "Windows still needs a device name");
  const win = loadConfig({ ...base, JARVIS_MIC: "Mikrofon", USERPROFILE: "C:/Users/x", APPDATA: "C:/Users/x/AppData/Roaming" }, "win32");
  assert.match(win.claudeBin.replace(/\\/g, "/"), /claude-code\/bin\/claude\.exe$/);
});
t("workers are blocked from macOS keychain, AppleScript, sudo and mail", () => {
  for (const rule of ["Bash(sudo:*)", "Bash(security:*)", "Bash(osascript:*)", "Bash(sendmail:*)", "Bash(rm -fr:*)"]) assert.ok(WORKER_DISALLOWED.includes(rule), rule);
});

// ---- agents talk back: status, questions, messages, task board ---------------------
t("agents: the session id, status lines and questions are picked up", () => {
  assert.deepEqual(parseWorkerEvent(JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123" })), [{ kind: "session", id: "abc-123" }]);
  assert.equal(statusLine("Fant tre e-poster om budet; leser den nyeste. Deretter sjekker jeg vedlegget."), "Fant tre e-poster om budet; leser den nyeste.");
  assert.equal(statusLine("**Søker** i innboksen"), "Søker i innboksen");
  assert.equal(questionIn("Jeg fant to eiendommer.\nSPØRSMÅL: Mener du engen i Arendal eller i Grimstad?"), "Mener du engen i Arendal eller i Grimstad?");
  assert.equal(questionIn("Alt er gjort."), undefined);
});
t("agents: a question becomes [Agenten spør] with an instruction to use message_task", () => {
  const note = finishNote({ id: "t1", title: "Sjekk bud", description: "d", status: "done", startedAt: "", progress: "", steps: 3, result: "Fant to. SPØRSMÅL: Hvilken eng?", question: "Hvilken eng?" });
  assert.match(note, /^\[Agenten spør\]/);
  assert.match(note, /message_task/);
  assert.doesNotMatch(note, /SPØRSMÅL/);
  assert.match(updateNote({ id: "t1", title: "Sjekk bud", startedAt: new Date(Date.now() - 30000).toISOString() }, "Leser e-posten."), /^\[Agentstatus\] "Sjekk bud" \(t1\), 30 s inne i jobben: Leser e-posten\.$/);
});
t("agents: the task board shows running work, open questions and recent results", () => {
  const now = Date.parse("2026-11-18T20:00:00Z");
  const board = taskBoard([
    { id: "t1", title: "Sjekk bud", description: "", status: "running", startedAt: "2026-11-18T19:59:00Z", progress: "", steps: 4, update: "Leser den nyeste e-posten.", updatedAt: "2026-11-18T19:59:50Z" },
    { id: "t2", title: "Finn stemme", description: "", status: "done", startedAt: "2026-11-18T19:50:00Z", endedAt: "2026-11-18T19:55:00Z", progress: "", steps: 2, result: "Fant to. SPØRSMÅL: Mann eller kvinne?", question: "Mann eller kvinne?" },
    { id: "t3", title: "Tell filer", description: "", status: "done", startedAt: "2026-11-18T19:40:00Z", endedAt: "2026-11-18T19:45:00Z", progress: "", steps: 2, result: "Det er 20 filer." },
    { id: "t4", title: "Gammel", description: "", status: "done", startedAt: "2026-11-18T10:00:00Z", endedAt: "2026-11-18T10:05:00Z", progress: "", steps: 1, result: "x" },
  ], now);
  assert.match(board, /t1 «Sjekk bud»: kjører i 60 s, 4 steg\. Siste status: Leser den nyeste e-posten\. \(10 s siden\)/);
  assert.match(board, /t2 «Finn stemme»: venter på svar fra Tor Martin: Mann eller kvinne\?/);
  assert.match(board, /t3 «Tell filer»: ferdig for 15 min siden\. Det er 20 filer\./);
  assert.doesNotMatch(board, /Gammel/);
  assert.equal(taskBoard([], now), "");
});
t("agents: message_task reaches the agent on his word; never from a report turn; missing fields are refused", () => {
  const sent = [];
  let said = "Det er engen i Arendal.";
  const deps = {
    tasks: { start: () => ({}), list: () => [], cancel: () => false, message: (id, text) => (sent.push([id, text]), `Sent to ${id}`) },
    memory: { add: () => true, forget: () => 0 },
    lastUserText: () => said, previousReply: () => "",
  };
  assert.equal(runLunaTool(deps, "message_task", { id: "t1", message: "Engen i Arendal." }), "Sent to t1");
  assert.deepEqual(sent, [["t1", "Engen i Arendal."]]);
  assert.match(runLunaTool(deps, "message_task", { id: "t1" }), /ERROR/);
  said = ""; // a turn started by a task report
  assert.match(runLunaTool(deps, "message_task", { id: "t1", message: "Let videre." }), /^BLOCKED/);
  assert.equal(sent.length, 1);
});
t("speech: file paths are reduced to the folder or file name", () => {
  assert.equal(toSpeech("Fant C:\\Users\\torma\\jarvis-voice med 22 filer."), "Fant jarvis-voice med 22 filer.");
  assert.equal(toSpeech("Mappen ~/voice finnes ikke."), "Mappen voice finnes ikke.");
  assert.equal(toSpeech("Største er src\\conversation.ts."), "Største er src\\conversation.ts.");
});

// ---- study packs -----------------------------------------------------------------
t("study packs: found by course code however it is written, and private voice rules come first", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-study-"));
  writeFileSync(join(dir, "ing400.md"), "# ING400 – øvingsprompt\n\nDagmulkt NS 8405: 1 promille per hverdag.");
  const packs = new StudyPacks(dir);
  assert.deepEqual(packs.list(), [{ name: "ing400", title: "ING400 – øvingsprompt" }]);
  for (const q of ["ING400", "ing 400", "ING-400", "", "ing400-øving"]) assert.equal(packs.find(q)?.name, "ing400", q);
  assert.equal(packs.find("kjemi"), null);
  const text = studyInstructions(packs.find("ing400"));
  assert.ok(text.indexOf("ØVINGSMODUS") < text.indexOf("Dagmulkt NS 8405"), "voice rules before the material");
  assert.match(text, /NS 8405, NLM 19/);
  assert.equal(new StudyPacks(join(dir, "missing")).list().length, 0);
});
t("study packs: «modus: rollespill» makes Jarvis play the role, with feedback only at the end", () => {
  const dir = mkdtempSync(join(tmpdir(), "jv-role-"));
  writeFileSync(join(dir, "yassin-mote.md"), "---\nmodus: rollespill\n---\n# Salgsmøte med Yassin\n\nDu er Yassin, økonomisjef.");
  writeFileSync(join(dir, "ing400.md"), "# ING400\n\nNS 8405.");
  const packs = new StudyPacks(dir);
  assert.deepEqual(packs.list().find((p) => p.name === "yassin-mote"), { name: "yassin-mote", title: "Salgsmøte med Yassin" });
  const role = packs.find("yassin");
  assert.equal(role?.mode, "rollespill");
  assert.ok(!role.text.includes("modus:"), "the front matter is not part of the material");
  const text = studyInstructions(role);
  assert.match(text, /^ROLLESPILL: Salgsmøte med Yassin/);
  assert.ok(text.indexOf("Bli i rollen") < text.indexOf("Du er Yassin"), "role rules before the material");
  assert.match(text, /avslutt øvingen/);
  assert.doesNotMatch(text, /Karakterestimat/, "no exam grading in a role-play");
  assert.equal(packs.find("ing400")?.mode, "eksamen");
  assert.match(studyInstructions(packs.find("ing400")), /^ØVINGSMODUS/);
  assert.equal(splitFrontMatter("---\r\nmodus: rollespill\r\n---\r\nTekst").mode, "rollespill");
  assert.deepEqual(splitFrontMatter("Ingen front matter"), { mode: "eksamen", body: "Ingen front matter" });
});

t("speech: standard numbers are read in pairs the Norwegian way, in code", () => {
  assert.equal(speakStandards("NS 8405"), "NS åttifire null fem");
  assert.equal(speakStandards("NS 8401 og NS 8407"), "NS åttifire null en og NS åttifire null sju");
  assert.equal(speakStandards("NS 3720"), "NS trettisju tjue");
  assert.equal(speakStandards("NS 3420"), "NS trettifire tjue");
  assert.equal(speakStandards("NLM 19 pkt. 74"), "NLM nitten pkt. 74");
  assert.equal(speakStandards("FOA § 13-2 og avtl. §§ 4 og 6"), "FOA paragraf 13-2 og avtl. paragrafene 4 og 6");
  assert.equal(speakStandards("1 ‰ per hverdag"), "1 promille per hverdag");
  assert.equal(toSpeech("Etter **NS 8405** er det 1 ‰."), "Etter NS åttifire null fem er det 1 promille.");
});

console.log(`\n${passed} tests passed`);
