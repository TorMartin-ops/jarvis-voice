import { spawn } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * Background worker: runs one Claude Code task non-interactively on this PC.
 * Uses the same Claude login as the desktop app, so no API credits are spent.
 * The binary is spawned directly (no shell), so the task text cannot inject commands.
 */
export const CLAUDE_BIN =
  process.env.CLAUDE_BIN?.trim() ||
  join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
export const WORKER_CWD = process.env.JARVIS_WORKER_CWD?.trim() || process.env.USERPROFILE || process.cwd();
const TIMEOUT_MS = Number(process.env.JARVIS_TASK_TIMEOUT_MS) || 30 * 60_000;
const REPORT_DIR = join(process.env.USERPROFILE ?? process.cwd(), ".jarvis", "reports");

export const WORKER_RULES = `You are a background worker for a voice assistant. Work on the task below and finish it.
Rules:
- Do not send messages or email, do not post anywhere, do not pay, do not delete data, and do not change permissions or config, unless the task explicitly asks and names exactly what to do.
- If you need a decision you cannot make, stop and say what you need in your final answer.
- End with a short final answer (3 to 6 sentences, plain text, no markdown) that says what you did and what the outcome is.`;

export interface WorkerResult {
  id: string;
  ok: boolean;
  /** Short text for speech. */
  summary: string;
  /** Full output, stored on disk. */
  reportPath: string;
}

export function startWorker(
  id: string,
  description: string,
  onDone: (result: WorkerResult) => void,
): void {
  const prompt = `${WORKER_RULES}\n\nTask:\n${description}`;
  const child = spawn(
    CLAUDE_BIN,
    ["-p", prompt, "--permission-mode", "auto", "--output-format", "text"],
    { cwd: WORKER_CWD, windowsHide: true },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  const timer = setTimeout(() => child.kill(), TIMEOUT_MS);

  child.on("close", (code) => {
    clearTimeout(timer);
    const text = (out || err || "(no output)").trim();
    mkdirSync(REPORT_DIR, { recursive: true });
    const reportPath = join(REPORT_DIR, `${id}.txt`);
    writeFileSync(reportPath, text, { mode: 0o600 });
    onDone({ id, ok: code === 0, summary: summarize(text, code), reportPath });
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    onDone({ id, ok: false, summary: `Kunne ikke starte arbeidsagenten: ${e.message}`, reportPath: "" });
  });
}

/** First few sentences, capped, so the voice reply stays short. */
export function summarize(text: string, code: number | null): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+/g) ?? [flat];
  const head = sentences.slice(0, 3).map((s) => s.trim()).join(" ");
  const capped = head.length > 500 ? head.slice(0, 500).replace(/\s+\S*$/, "") + "." : head;
  return code === 0 ? capped || "Ferdig." : `Oppgaven feilet (kode ${code}). ${capped}`.trim();
}
