import { join } from "path";
import { homedir } from "os";
import { loadConfig, loadDotEnv, ConfigError, type Config } from "./config.js";
import { startMic, listMicDevices, type Mic } from "./mic.js";
import { Speaker } from "./speaker.js";
import { SpeechBuffer } from "./audio-utils.js";
import { SpeechToText } from "./stt.js";
import { Brain } from "./brain.js";
import { WakeGate } from "./gate.js";
import { Conversation } from "./conversation.js";
import { TaskManager, type TaskInfo } from "./tasks.js";
import { Memory } from "./memory.js";
import { runLunaTool, finishNote, afterTools, taskBoard, updateNote } from "./luna-tools.js";
import { StudyPacks, studyInstructions, roleplayFeedbackInstructions, type StudyPack } from "./study.js";

const UPDATE_FIRST_MS = 15_000;
const UPDATE_EVERY_MS = 60_000;
const UPDATE_SETTLE_MS = 3_000;
/** In a study session, answer after this much quiet (answers are long and have pauses), or at once on "ferdig". */
const STUDY_PATIENCE_MS = 1_800;
import { redact } from "./policy.js";
import { toLogFile } from "./debug.js";

function log(msg: string): void {
  const line = `${new Date().toLocaleTimeString("nb-NO")} ${redact(msg)}`;
  console.log(line);
  toLogFile(line);
}

/** Build the whole assistant. Exported so the end-to-end test can drive it without a microphone. */
export async function createAssistant(
  cfg: Config,
  logFn: (m: string) => void = log,
  extra: { onAudioOut?: (pcm: Buffer) => void } = {},
) {
  const memory = new Memory(join(cfg.dataDir, "memory.json"));
  const packs = new StudyPacks(join(cfg.dataDir, "study"));
  let study: StudyPack | null = null;
  // A role-play that just ended: its material stays in context until he speaks again, so the
  // feedback that follows stop_study is based on it.
  let ending: { pack: StudyPack; heardBefore: string } | null = null;
  // What Tor Martin said this turn; the confirmation gate checks it before any outward action.
  let lastUserText = "";
  let previousReply = "";
  let conversation: Conversation | null = null;

  // Spoken progress: the first update after UPDATE_FIRST_MS, then at most one per task per UPDATE_EVERY_MS,
  // so quick jobs only report when done and long ones never go silent. Not during a study session.
  const lastSpokenUpdate = new Map<string, number>();
  const onUpdate = (t: TaskInfo, text: string) => {
    const now = Date.now();
    if (study || now - Date.parse(t.startedAt) < UPDATE_FIRST_MS) return;
    if (now - (lastSpokenUpdate.get(t.id) ?? 0) < UPDATE_EVERY_MS) return;
    lastSpokenUpdate.set(t.id, now);
    // The agent's last text is also its final answer: wait a moment, and say nothing if it finished
    // meanwhile (the finish report covers it).
    setTimeout(() => {
      if (t.status !== "running" || t.update !== text) return;
      logFn(`task ${t.id} update: ${text}`);
      conversation?.announce(updateNote(t, text));
    }, UPDATE_SETTLE_MS);
  };

  const tasks = new TaskManager({
    claudeBin: cfg.claudeBin,
    cwd: cfg.workerCwd,
    dir: cfg.dataDir,
    timeoutMs: cfg.taskTimeoutMs,
    model: cfg.workerModel,
    onUpdate,
    onFinish: (t) => {
      lastSpokenUpdate.delete(t.id);
      logFn(`task ${t.id} ${t.status}${t.question ? " (asks a question)" : ""}${t.costUsd !== undefined ? ` ($${t.costUsd.toFixed(3)})` : ""}`);
      conversation?.announce(finishNote(t));
    },
  });

  /** Feedback instructions while a role-play's feedback is due; cleared once he speaks again. */
  const endingContext = (): string => {
    if (ending && lastUserText !== ending.heardBefore) ending = null;
    return ending ? roleplayFeedbackInstructions(ending.pack) : "";
  };

  const studyControl = {
    start: (name?: string) => {
      const pack = packs.find(name);
      if (!pack) {
        const names = packs.list().map((p) => p.name);
        return names.length ? `No study pack matches "${name ?? ""}". Available: ${names.join(", ")}.` : "No study packs found in ~/.jarvis/study.";
      }
      study = pack;
      ending = null;
      logFn(`study session started: ${pack.name}`);
      return pack.mode === "rollespill"
        ? `Role-play "${pack.title}" started. Its instructions are now in your context: you are the person it describes. Open in that role exactly as the material says, and stay in it.`
        : `Study session "${pack.title}" started. Its instructions are now in your context: greet him as the examiner and begin as they say.`;
    },
    stop: () => {
      if (!study) return "No study session is running.";
      logFn(`study session ended: ${study.name}`);
      const pack = study;
      study = null;
      if (pack.mode === "rollespill") {
        ending = { pack, heardBefore: lastUserText };
        return "Role-play ended. Step out of the role now and give the feedback the material describes, in full, as speech. Do not call stop_study again.";
      }
      return "Study session ended. Back to normal conversation.";
    },
  };

  const brain = new Brain({
    endpoint: cfg.azure.endpoint,
    apiKey: cfg.azure.key,
    deployment: cfg.azure.deployment,
    apiVersion: cfg.azure.apiVersion,
    reasoningEffort: cfg.azure.reasoningEffort,
    // Stable parts first and the clock last, so Azure can reuse the cached prompt prefix.
    context: () => {
      const now = new Date();
      const when = now.toLocaleString("nb-NO", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const available = packs.list();
      return [
        study ? studyInstructions(study) : "",
        endingContext(),
        !study && available.length ? `Øvingspakker du kan starte med start_study: ${available.map((p) => `${p.name} («${p.title}»)`).join(", ")}.` : "",
        memory.render(),
        taskBoard(tasks.list(), now.getTime()),
        `Nå er det ${when} (Norge).`,
      ].filter(Boolean).join("\n\n");
    },
    runTool: (name, args) =>
      runLunaTool({ tasks, memory, study: studyControl, lastUserText: () => lastUserText, previousReply: () => previousReply, log: logFn }, name, args),
    afterTools,
    limits: () => (study || endingContext() ? { maxTokens: 1200, maxHistory: 80, cacheKey: `jarvis-study-${(study ?? ending!.pack).name}`, reasoningEffort: cfg.azure.studyReasoningEffort } : { maxTokens: 500, maxHistory: 40, cacheKey: "jarvis-luna" }),
  });

  conversation = new Conversation({
    buffer: await SpeechBuffer.create(cfg.endSilenceMs ? { silenceDuration: cfg.endSilenceMs } : {}),
    stt: new SpeechToText({ apiKey: cfg.elevenKey, model: cfg.sttModel, language: cfg.language }),
    brain,
    speaker: new Speaker(cfg.ffplayPath),
    gate: new WakeGate(cfg.wakeWords, cfg.wakeWindowMs),
    tts: { apiKey: cfg.elevenKey, voice: cfg.ttsVoice, model: cfg.ttsModel, language: cfg.ttsLanguage },
    bargeInMs: cfg.bargeInMs,
    mergeMs: cfg.mergeMs,
    audioMode: cfg.audioMode,
    onAudioOut: extra.onAudioOut,
    onUserTurn: (text, before) => {
      lastUserText = text;
      previousReply = before;
    },
    patienceMs: () => (study ? STUDY_PATIENCE_MS : 0),
    alwaysListen: () => study !== null,
    log: logFn,
  });

  return { conversation, tasks, memory, brain, study: studyControl };
}

async function main(): Promise<void> {
  process.env.VOICE_DEBUG ??= "1";
  // Personal overrides in the data folder (model, voice) win over the repository's .env.
  loadDotEnv(join(process.env.JARVIS_DATA_DIR || join(homedir(), ".jarvis"), "settings.conf"));
  loadDotEnv(join(process.cwd(), ".env"));

  if (process.argv.includes("--devices")) {
    const names = await listMicDevices();
    console.log(names.length ? names.map((n) => `JARVIS_MIC="${n}"`).join("\n") : "No audio devices found.");
    return;
  }

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const { conversation, tasks } = await createAssistant(cfg);

  let mic: Mic | null = null;
  const shutdown = async () => {
    log("stopping");
    mic?.stop();
    tasks.shutdown();
    await conversation.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  mic = startMic(
    cfg.micDevice,
    (pcm) => conversation.onMic(pcm),
    (msg) => log(`microphone: ${msg}`),
  );
  log(`listening on "${cfg.micDevice}" (${cfg.audioMode}). Say "${cfg.wakeWords[0] ?? "Jarvis"}" to start.`);
  conversation.greet();
}

// Run only when started directly (not when imported by the e2e test).
if (process.argv[1] && /index\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(redact(`fatal: ${(err as Error).stack ?? err}`));
    process.exit(1);
  });
}
