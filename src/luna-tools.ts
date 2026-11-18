import type { TaskInfo } from "./tasks.js";

/** What Luna's tools need from the rest of the app. Kept as an interface so tests can use fakes. */
export interface ToolDeps {
  tasks: {
    start(title: string, description: string, confirmedAction?: string): TaskInfo;
    list(): TaskInfo[];
    cancel(id: string): boolean;
    message?(id: string, text: string): string;
  };
  study?: {
    start(name?: string): string;
    stop(): string;
  };
  memory: {
    add(text: string): boolean;
    forget(phrase: string): number;
  };
  /** What Tor Martin said in the current turn ("" for turns he did not start, such as task reports). */
  lastUserText: () => string;
  /** What the assistant said in the turn before this one. */
  previousReply: () => string;
  log?: (msg: string) => void;
}

/**
 * True when the utterance is an explicit go-ahead for an outward action, such as "ja, send",
 * "send den", "ja, gjør det" or "kjør på". A bare "ja" is not enough, and any "nei", "ikke",
 * "vent" or "stopp" cancels. Enforced in code because the model cannot be trusted to wait.
 */
export function isConfirmation(text: string): boolean {
  const t = text.toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t || /\b(nei|ikke|vent|stopp|avbryt|glem det)\b/.test(t)) return false;
  // "sen"/"senn" covers the common transcription of a quickly spoken "send".
  return /\b(send|sende|sen|senn|gjør det|kjør på|kjør|bekrefter|bekreftet|godkjent|godkjenner|publiser|slett)\b/.test(t);
}

/**
 * The code-level gate for confirmed_action. All three must hold:
 * 1. the previous reply asked for confirmation (so the action was read back first),
 * 2. this utterance is an explicit go-ahead, and
 * 3. it is short, so the request itself ("send en e-post til ...") can never count as its own confirmation.
 */
export function confirmationGate(userText: string, previousReply: string): boolean {
  const short = userText.trim().split(/\s+/).filter(Boolean).length <= 6;
  return askedForConfirmation(previousReply) && short && isConfirmation(userText);
}

/** True when a reply read an action back and asked for a go-ahead. */
export function askedForConfirmation(reply: string): boolean {
  return /ja, send|«ja|bekreft|gjør det\?|skal jeg sende|skal jeg gjøre/i.test(reply);
}

export interface ToolOutcome {
  name: string;
  result: string;
}

/** Results that mean the tool did what was asked. Anything else (errors, blocks, "nothing matched") needs Luna to explain. */
/**
 * Quiet tools: once Luna has said something, there is nothing to add after they succeed.
 * start_task, message_task and the study tools are deliberately not here: after them Luna should
 * say in her own words what happens next, instead of a canned "skal bli".
 */
const QUIET_SUCCESS: Record<string, RegExp> = {
  cancel_task: /^Cancelled/,
  remember: /^(Saved|Already remembered)/,
  forget: /^Forgot/,
};
const quietOk = (o: ToolOutcome) => QUIET_SUCCESS[o.name]?.test(o.result) ?? false;

/**
 * What happens after a round of tool calls:
 * - quiet tools that succeeded after Luna already spoke: end the turn (saves a model call);
 * - start_task blocked right after Luna asked for confirmation: end the turn, the question stands;
 * - anything else: let Luna continue and speak.
 */
export function afterTools(outcomes: ToolOutcome[], spoken: string): { say?: string; stop: boolean } {
  if (!spoken.trim()) return { stop: false };
  if (outcomes.every(quietOk)) return { stop: true };
  const onlyBlocked = outcomes.every((o) => quietOk(o) || o.result.startsWith("BLOCKED"));
  return { stop: onlyBlocked && outcomes.some((o) => o.result.startsWith("BLOCKED")) && askedForConfirmation(spoken) };
}

const ago = (iso: string | undefined, now: number) => {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
};

/**
 * The task board Luna sees on every turn, so she never forgets an agent: what runs, its latest
 * status in its own words, open questions, and what finished recently.
 */
export function taskBoard(tasks: TaskInfo[], now = Date.now()): string {
  const running = tasks.filter((t) => t.status === "running");
  const asking = tasks.filter((t) => t.question && t.status === "done" && now - Date.parse(t.endedAt ?? t.startedAt) < 6 * 3600_000);
  const recent = tasks.filter((t) => t.status !== "running" && !t.question && t.endedAt && now - Date.parse(t.endedAt) < 30 * 60_000).slice(0, 4);
  if (!running.length && !asking.length && !recent.length) return "";
  const lines = ["Oppgavetavle (agentene dine):"];
  for (const t of running) lines.push(`- ${t.id} «${t.title}»: kjører i ${ago(t.startedAt, now)}, ${t.steps} steg. Siste status: ${t.update ?? "ingen ennå"}${t.update ? ` (${ago(t.updatedAt, now)} siden)` : ""}.`);
  for (const t of asking) lines.push(`- ${t.id} «${t.title}»: venter på svar fra Tor Martin: ${t.question}`);
  for (const t of recent) lines.push(`- ${t.id} «${t.title}»: ${STATUS_NO[t.status]} for ${ago(t.endedAt, now)} siden. ${(t.result ?? "").replace(/\s+/g, " ").slice(0, 220)}`);
  return lines.join("\n");
}

const STATUS_NO: Record<TaskInfo["status"], string> = {
  running: "kjører",
  done: "ferdig",
  failed: "feilet",
  cancelled: "avbrutt",
  timeout: "tidsavbrudd",
  lost: "mistet (appen ble startet på nytt)",
};

/** Run one of Luna's tools. Always returns text for the model; never throws. */
export function runLunaTool(deps: ToolDeps, name: string, args: Record<string, unknown>): string {
  const str = (k: string) => String(args[k] ?? "").trim();
  switch (name) {
    case "start_task": {
      const title = str("title") || "Oppgave";
      const description = str("description");
      if (!description) return "ERROR: description is required.";
      const confirmed = str("confirmed_action") || undefined;
      if (confirmed && !confirmationGate(deps.lastUserText(), deps.previousReply())) {
        deps.log?.(`blocked: confirmed_action without a spoken confirmation ("${title}")`);
        return "BLOCKED: confirmed_action is only accepted right after Tor Martin says something like «ja, send» or «ja, gjør det». No task was started. Read back exactly what will happen, ask him, and wait for his answer.";
      }
      const task = deps.tasks.start(title, description, confirmed);
      deps.log?.(`task ${task.id} started: ${title}${confirmed ? " (with confirmed action)" : ""}`);
      return `Started task ${task.id} ("${title}"). Tell him in your own words what the agent will do and roughly how long it takes (usually one to two minutes), and that you will keep him posted. Progress arrives as [Agentstatus], the result as [Oppgave ferdig].`;
    }
    case "list_tasks": {
      const list = deps.tasks.list().slice(0, 8);
      if (!list.length) return "No tasks.";
      return list
        .map((t) => `${t.id}: ${t.title} - ${STATUS_NO[t.status]}${t.status === "running" ? ` (${t.progress})` : ""}`)
        .join("\n");
    }
    case "cancel_task":
      return deps.tasks.cancel(str("id")) ? "Cancelled." : "No running task with that id.";
    case "message_task": {
      const id = str("id");
      const text = str("message");
      if (!id || !text) return "ERROR: id and message are required.";
      if (!deps.tasks.message) return "ERROR: messaging agents is not available.";
      // Only on his word: a turn started by a task report has no user text, so it cannot answer for him.
      if (!deps.lastUserText().trim()) {
        deps.log?.(`blocked: message to ${id} without anything from Tor Martin this turn`);
        return "BLOCKED: messages to an agent are only sent right after Tor Martin has said what to send. Ask him and wait for his answer.";
      }
      const res = deps.tasks.message(id, text);
      deps.log?.(`message to ${id}: ${res}`);
      return res;
    }
    case "start_study":
      return deps.study ? deps.study.start(str("name") || undefined) : "ERROR: study packs are not available.";
    case "stop_study":
      return deps.study ? deps.study.stop() : "No study session.";
    case "remember":
      return deps.memory.add(str("fact")) ? "Saved." : "Already remembered, or empty.";
    case "forget": {
      const n = deps.memory.forget(str("phrase"));
      return n ? `Forgot ${n} fact(s).` : "Nothing matched.";
    }
    default:
      return `ERROR: unknown tool ${name}.`;
  }
}

/** The note Luna receives when a worker finishes. */
export function finishNote(t: TaskInfo): string {
  if (t.question) {
    return `[Agenten spør] "${t.title}" (${t.id}) trenger en beslutning: ${t.question}\nDet agenten har gjort så langt: ${(t.result ?? "").replace(/SPØRSMÅL:[\s\S]*$/i, "").trim()}\nStill spørsmålet til Tor Martin med egne ord, og send svaret hans til agenten med message_task.`;
  }
  const status = STATUS_NO[t.status];
  return `[Oppgave ferdig] "${t.title}" (${t.id}) er ${status}. Resultat: ${t.result ?? "(ingen tekst)"}`;
}

/** The note Luna receives when an agent reports progress while working. */
export function updateNote(t: TaskInfo, text: string, now = Date.now()): string {
  return `[Agentstatus] "${t.title}" (${t.id}), ${ago(t.startedAt, now)} inne i jobben: ${text}`;
}
