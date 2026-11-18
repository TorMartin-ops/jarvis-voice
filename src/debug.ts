/**
 * Opt-in debug logging.
 *   VOICE_DEBUG=1  timings and lengths only
 *   VOICE_DEBUG=2  also logs transcript text (may contain private speech)
 *
 * Debug lines go to stderr. Timing lines (numbers only, never transcript
 * text) are also appended to ~/.jarvis/latency.log for later analysis.
 */
import { appendFileSync, statSync, truncateSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Read at call time: index.ts loads .env after this module is imported.
function level(): number {
  return process.env.VOICE_DEBUG === "2" ? 2 : process.env.VOICE_DEBUG === "1" ? 1 : 0;
}
const timingLog = () => join(process.env.JARVIS_DATA_DIR || join(homedir(), ".jarvis"), "latency.log");
const MAX_TIMING_LOG_BYTES = 2 * 1024 * 1024;
let timingLogChecked = false;

export function debugEnabled(): boolean {
  return level() >= 1;
}

export function debugLog(msg: string): void {
  if (level() < 1) return;
  process.stderr.write(`jarvis: ${msg}\n`);
}

/** Log a latency measurement. `msg` must not contain transcript text. */
export function timing(msg: string): void {
  if (level() < 1) return;
  debugLog(msg);
  try {
    if (!timingLogChecked) {
      timingLogChecked = true;
      const size = statSync(timingLog(), { throwIfNoEntry: false })?.size ?? 0;
      if (size > MAX_TIMING_LOG_BYTES) truncateSync(timingLog(), 0);
    }
    appendFileSync(timingLog(), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    // best-effort
  }
}

/** Log content only at VOICE_DEBUG=2; otherwise just its length. */
export function debugText(label: string, text: string): string {
  return level() >= 2 ? `${label}="${text}"` : `${label}_chars=${text.length}`;
}
