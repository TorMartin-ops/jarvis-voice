import { spawn } from "child_process";
import { tmpdir } from "os";
import { CLAUDE_BIN } from "./worker.js";
import { SYSTEM_PROMPT, type BrainHooks } from "./brain.js";

/**
 * Brain without an API key: each turn runs `claude -p` on this PC (the Claude login
 * covers it, no API credits). Slower than the API brain and not streamed, so the
 * reply arrives as one block. Use this until API credits are available.
 */
const MODEL = process.env.JARVIS_CLI_MODEL?.trim() || "haiku";
const MAX_HISTORY = 16;
const DELEGATE_PREFIX = "DELEGATE:";

export interface ParsedReply {
  speech: string[];
  delegations: string[];
}

/** Split the model's output into spoken lines and task requests. */
export function parseReply(text: string): ParsedReply {
  const speech: string[] = [];
  const delegations: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(DELEGATE_PREFIX)) {
      const task = line.slice(DELEGATE_PREFIX.length).trim();
      if (task) delegations.push(task);
    } else {
      speech.push(line.replace(/[*_`#]+/g, "").trim());
    }
  }
  return { speech: speech.filter(Boolean), delegations };
}

export class CliBrain {
  private history: string[] = [];

  note(text: string): void {
    this.history.push(`System: ${text}`);
    this.trim();
  }

  async respond(userText: string | null, hooks: BrainHooks, signal?: AbortSignal): Promise<void> {
    if (userText) this.history.push(`Tor: ${userText}`);
    const prompt = buildPrompt(SYSTEM_PROMPT, this.history);
    const output = await runClaude(prompt, signal);
    const { speech, delegations } = parseReply(output);
    const statuses: string[] = [];
    for (const task of delegations) statuses.push(hooks.onDelegate(task));
    const spoken = speech.join(" ");
    if (spoken) hooks.onText(spoken);
    this.history.push(`Jarvis: ${[spoken, ...delegations.map((d) => `(startet oppgave: ${d})`)].filter(Boolean).join(" ")}`);
    this.trim();
  }

  private trim(): void {
    if (this.history.length > MAX_HISTORY) this.history = this.history.slice(-MAX_HISTORY);
  }
}

export function buildPrompt(system: string, history: string[]): string {
  return [
    system,
    "",
    "Samtalen så langt (nyeste sist):",
    ...history,
    "",
    "Svar nå som Jarvis, med kun det som skal leses opp. Ingen forklaring, ingen markdown.",
    `Hvis oppgaven krever verktøy eller flere steg, skriv en egen linje som starter med ${DELEGATE_PREFIX} og en selvstendig oppgavebeskrivelse, og si kort i talen at du setter i gang.`,
  ].join("\n");
}

function runClaude(prompt: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      CLAUDE_BIN,
      ["-p", prompt, "--model", MODEL, "--effort", "low", "--tools", "", "--output-format", "text"],
      { cwd: tmpdir(), windowsHide: true },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.trim().slice(0, 200)}`));
      resolve(out.trim());
    });
  });
}
