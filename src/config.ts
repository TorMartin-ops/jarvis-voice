import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/** Everything the app needs, read once from the environment (.env loaded first). */
export interface Config {
  elevenKey: string;
  sttModel?: string;
  ttsModel: string;
  ttsVoice: string;
  /** Sent as language_code to TTS; leave unset for models that reject it (eleven_v4_turbo). */
  ttsLanguage?: string;
  language?: string;
  azure: { endpoint: string; key: string; deployment: string; apiVersion: string; reasoningEffort: ReasoningEffort; studyReasoningEffort: ReasoningEffort };
  micDevice: string;
  wakeWords: string[];
  wakeWindowMs: number;
  endSilenceMs?: number;
  bargeInMs: number;
  mergeMs: number;
  audioMode: "headset" | "speakers";
  taskTimeoutMs: number;
  workerModel?: string;
  dataDir: string;
  workerCwd: string;
  ffplayPath: string;
  claudeBin: string;
}

export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high";
const EFFORTS: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high"];

export class ConfigError extends Error {}

function effort(env: NodeJS.ProcessEnv, key: string, fallback: ReasoningEffort): ReasoningEffort {
  const v = (env[key]?.trim() || fallback) as ReasoningEffort;
  if (!EFFORTS.includes(v)) throw new ConfigError(`${key} must be one of ${EFFORTS.join(", ")}, got "${v}"`);
  return v;
}

/** Load KEY=VALUE lines into `env` without overriding values already set. */
export function loadDotEnv(path: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (env[key] === undefined || env[key] === "") env[key] = value;
  }
}

const str = (env: NodeJS.ProcessEnv, k: string): string | undefined => env[k]?.trim() || undefined;
const num = (env: NodeJS.ProcessEnv, k: string): number | undefined => {
  const v = str(env, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`${k} must be a non-negative number, got "${v}"`);
  return n;
};

/**
 * Where Claude Code usually lives: the native installer puts it in ~/.local/bin; on Windows the npm
 * global install is under %APPDATA%. Falls back to "claude" on PATH (macOS) or the npm path (Windows).
 */
export function defaultClaudeBin(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, home: string): string {
  const native = join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude");
  if (platform !== "win32") return existsSync(native) ? native : "claude";
  const npm = join(env.APPDATA ?? join(home, "AppData", "Roaming"), "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
  return existsSync(npm) || !existsSync(native) ? npm : native;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Config {
  const missing: string[] = [];
  const need = (k: string): string => {
    const v = str(env, k);
    if (!v) missing.push(k);
    return v ?? "";
  };
  const elevenKey = need("ELEVENLABS_API_KEY");
  const azure = {
    endpoint: need("AZURE_OPENAI_ENDPOINT"),
    key: need("AZURE_OPENAI_API_KEY"),
    deployment: need("AZURE_OPENAI_DEPLOYMENT"),
    apiVersion: str(env, "AZURE_OPENAI_API_VERSION") ?? "2024-10-21",
    reasoningEffort: effort(env, "JARVIS_REASONING_EFFORT", "none"),
    // Practice sessions think before answering: a role must not invent facts, and a short wait is fine there.
    studyReasoningEffort: effort(env, "JARVIS_STUDY_REASONING_EFFORT", "medium"),
  };
  // macOS can use the system default input; DirectShow on Windows has no default, so a name is required.
  const micDevice = platform === "darwin" ? str(env, "JARVIS_MIC") ?? "default" : need("JARVIS_MIC");
  const home = (platform === "win32" ? str(env, "USERPROFILE") : str(env, "HOME")) ?? homedir();
  if (missing.length) {
    throw new ConfigError(`Missing settings in .env: ${missing.join(", ")}. Run "npm run devices" to find JARVIS_MIC.`);
  }
  const wake = str(env, "JARVIS_WAKE_WORDS");
  const audioMode = str(env, "JARVIS_AUDIO_MODE") === "speakers" ? "speakers" : "headset";
  return {
    elevenKey,
    sttModel: str(env, "ELEVENLABS_STT_MODEL"),
    ttsModel: str(env, "ELEVENLABS_TTS_MODEL") ?? "eleven_v4_turbo",
    ttsVoice: str(env, "ELEVENLABS_VOICE_ID") ?? "BRY5wALXFkJsxVM6sEOH",
    ttsLanguage: str(env, "ELEVENLABS_TTS_LANGUAGE"),
    language: str(env, "JARVIS_LANGUAGE") ?? "nb-NO",
    azure,
    micDevice,
    wakeWords: wake === undefined ? ["jarvis", "luna", "claude", "klaude", "klod", "clod", "cloud", "claud"] : wake.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean),
    // Speakers usually means a shared room: a shorter window lets less of other people's talk through.
    wakeWindowMs: num(env, "JARVIS_WAKE_WINDOW_MS") ?? (audioMode === "speakers" ? 30_000 : 90_000),
    // 600 ms: research puts natural end-of-turn waits at 0.6 to 0.8 s; shorter values cut people off.
    endSilenceMs: num(env, "JARVIS_END_SILENCE_MS") ?? 600,
    bargeInMs: num(env, "JARVIS_BARGE_IN_MS") ?? 400,
    mergeMs: num(env, "JARVIS_MERGE_MS") ?? 800,
    audioMode,
    taskTimeoutMs: num(env, "JARVIS_TASK_TIMEOUT_MS") ?? 30 * 60_000,
    // Sonnet: fast and capable for background jobs; set JARVIS_WORKER_MODEL to override.
    workerModel: str(env, "JARVIS_WORKER_MODEL") ?? "sonnet",
    dataDir: str(env, "JARVIS_DATA_DIR") ?? join(home, ".jarvis"),
    workerCwd: str(env, "JARVIS_WORKER_CWD") ?? home,
    ffplayPath: str(env, "JARVIS_FFPLAY") ?? "ffplay",
    claudeBin: str(env, "CLAUDE_BIN") ?? defaultClaudeBin(env, platform, home),
  };
}
