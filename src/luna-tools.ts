import type { TaskInfo } from "./tasks.js";

/** What Luna's tools need from the rest of the app. Kept as an interface so tests can use fakes. */
export interface ToolDeps {
  tasks: {
    start(title: string, description: string, confirmedAction?: string): TaskInfo;
    list(): TaskInfo[];
    cancel(id: string): boolean;
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
  const asked = /ja, send|«ja|bekreft|gjør det\?|skal jeg sende|skal jeg gjøre/i.test(previousReply);
  const short = userText.trim().split(/\s+/).filter(Boolean).length <= 6;
  return asked && short && isConfirmation(userText);
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
      return `Started task ${task.id} ("${title}"). It runs in the background; the result arrives as [Oppgave ferdig].`;
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
  const status = STATUS_NO[t.status];
  return `[Oppgave ferdig] "${t.title}" (${t.id}) er ${status}. Resultat: ${t.result ?? "(ingen tekst)"}`;
}
