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
  log?: (msg: string) => void;
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
