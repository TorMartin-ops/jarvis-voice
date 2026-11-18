import { existsSync, readFileSync } from "fs";
import { join } from "path";

/** Everything the app needs, read once from the environment (.env loaded first). */
export interface Config {
  elevenKey: string;
  sttModel?: string;
  ttsModel: string;
  ttsVoice: string;
  language?: string;
  azure: { endpoint: string; key: string; deployment: string; apiVersion: string };
  micDevice: string;
  wakeWords: string[];
  wakeWindowMs: number;
  endSilenceMs?: number;
  bargeInMs: number;
  mergeMs: number;
  taskTimeoutMs: number;
  workerModel?: string;
  dataDir: string;
  workerCwd: string;
  ffplayPath: string;
  claudeBin: string;
}

export class ConfigError extends Error {}

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
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
  };
  const micDevice = need("JARVIS_MIC");
  if (missing.length) {
    throw new ConfigError(`Missing settings in .env: ${missing.join(", ")}. Run "npm run devices" to find JARVIS_MIC.`);
  }
  const wake = str(env, "JARVIS_WAKE_WORDS");
  return {
    elevenKey,
    sttModel: str(env, "ELEVENLABS_STT_MODEL"),
    ttsModel: str(env, "ELEVENLABS_TTS_MODEL") ?? "eleven_v4_turbo",
    ttsVoice: str(env, "ELEVENLABS_VOICE_ID") ?? "BRY5wALXFkJsxVM6sEOH",
    language: str(env, "JARVIS_LANGUAGE") ?? "nb-NO",
    azure,
    micDevice,
    wakeWords: wake === undefined ? ["jarvis", "luna", "claude", "klaude", "klod", "clod", "cloud", "claud"] : wake.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean),
    wakeWindowMs: num(env, "JARVIS_WAKE_WINDOW_MS") ?? 90_000,
    // 600 ms: research puts natural end-of-turn waits at 0.6 to 0.8 s; shorter values cut people off.
    endSilenceMs: num(env, "JARVIS_END_SILENCE_MS") ?? 600,
    bargeInMs: num(env, "JARVIS_BARGE_IN_MS") ?? 400,
    mergeMs: num(env, "JARVIS_MERGE_MS") ?? 800,
    taskTimeoutMs: num(env, "JARVIS_TASK_TIMEOUT_MS") ?? 30 * 60_000,
    workerModel: str(env, "JARVIS_WORKER_MODEL"),
    dataDir: str(env, "JARVIS_DATA_DIR") ?? join(env.USERPROFILE ?? process.cwd(), ".jarvis"),
    workerCwd: str(env, "JARVIS_WORKER_CWD") ?? env.USERPROFILE ?? process.cwd(),
    ffplayPath: str(env, "JARVIS_FFPLAY") ?? "ffplay",
    claudeBin: str(env, "CLAUDE_BIN") ?? join(env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
  };
}
