import { join } from "path";
import { loadConfig, loadDotEnv, ConfigError, type Config } from "./config.js";
import { startMic, listMicDevices, type Mic } from "./mic.js";
import { Speaker } from "./speaker.js";
import { SpeechBuffer } from "./audio-utils.js";
import { SpeechToText } from "./stt.js";
import { Brain } from "./brain.js";
import { WakeGate } from "./gate.js";
import { Conversation } from "./conversation.js";
import { TaskManager } from "./tasks.js";
import { Memory } from "./memory.js";
import { runLunaTool, finishNote } from "./luna-tools.js";
import { redact } from "./policy.js";

function log(msg: string): void {
  console.log(`${new Date().toLocaleTimeString("nb-NO")} ${redact(msg)}`);
}

/** Build the whole assistant. Exported so the end-to-end test can drive it without a microphone. */
export async function createAssistant(cfg: Config, logFn: (m: string) => void = log) {
  const memory = new Memory(join(cfg.dataDir, "memory.json"));
  let conversation: Conversation | null = null;

  const tasks = new TaskManager({
    claudeBin: cfg.claudeBin,
    cwd: cfg.workerCwd,
    dir: cfg.dataDir,
    timeoutMs: cfg.taskTimeoutMs,
    model: cfg.workerModel,
    onFinish: (t) => {
      logFn(`task ${t.id} ${t.status}${t.costUsd !== undefined ? ` ($${t.costUsd.toFixed(3)})` : ""}`);
      conversation?.announce(finishNote(t));
    },
  });

  const brain = new Brain({
    endpoint: cfg.azure.endpoint,
    apiKey: cfg.azure.key,
    deployment: cfg.azure.deployment,
    apiVersion: cfg.azure.apiVersion,
    context: () => memory.render(),
    runTool: (name, args) => runLunaTool({ tasks, memory, log: logFn }, name, args),
  });

  conversation = new Conversation({
    buffer: await SpeechBuffer.create(cfg.endSilenceMs ? { silenceDuration: cfg.endSilenceMs } : {}),
    stt: new SpeechToText({ apiKey: cfg.elevenKey, model: cfg.sttModel, language: cfg.language }),
    brain,
    speaker: new Speaker(cfg.ffplayPath),
    gate: new WakeGate(cfg.wakeWords, cfg.wakeWindowMs),
    tts: { apiKey: cfg.elevenKey, voice: cfg.ttsVoice, model: cfg.ttsModel },
    bargeInMs: cfg.bargeInMs,
    mergeMs: cfg.mergeMs,
    log: logFn,
  });

  return { conversation, tasks, memory, brain };
}

async function main(): Promise<void> {
  process.env.VOICE_DEBUG ??= "1";
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
  log(`listening on "${cfg.micDevice}". Say "${cfg.wakeWords[0] ?? "Jarvis"}" to start.`);
}

// Run only when started directly (not when imported by the e2e test).
if (process.argv[1] && /index\.js$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(redact(`fatal: ${(err as Error).stack ?? err}`));
    process.exit(1);
  });
}
