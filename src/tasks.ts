/**
 * Registry of background tasks, each tied to a Discord thread.
 *
 * The voice dispatcher hands work to agents; every task gets a thread where
 * the agent posts progress and its full report, so the spoken conversation
 * only needs a one-line summary. Persisted so thread links survive restarts.
 */

import { readFileSync, writeFileSync, renameSync } from "fs";

export const TASK_STATUSES = ["running", "done", "failed", "needs_input"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskRecord {
  threadId: string;
  guildId: string;
  name: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  lastUpdate: string;
  agentId?: string;
}

const MAX_TASKS = 100;
const MAX_LAST_UPDATE_CHARS = 300;
const DISCORD_MESSAGE_LIMIT = 2000;
const THREAD_NAME_LIMIT = 100;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

/** Strip control characters and collapse whitespace; names end up in thread titles. */
export function cleanTaskName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

const STATUS_PREFIX: Record<TaskStatus, string> = {
  running: "",
  done: "✅ ",
  failed: "❌ ",
  needs_input: "❓ ",
};

export function threadName(name: string, status: TaskStatus): string {
  return (STATUS_PREFIX[status] + name).slice(0, THREAD_NAME_LIMIT);
}

/** Split text into Discord-sized messages, preferring line breaks, then spaces. */
export function chunkMessage(text: string, max = DISCORD_MESSAGE_LIMIT): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = rest.lastIndexOf(" ", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export class TaskRegistry {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(private readonly file: string | null) {
    if (!file) return;
    try {
      const data = JSON.parse(readFileSync(file, "utf8")) as TaskRecord[];
      for (const task of Array.isArray(data) ? data : []) {
        if (task && typeof task.threadId === "string" && isTaskStatus(task.status)) this.tasks.set(task.threadId, task);
      }
    } catch {
      // no registry yet
    }
  }

  get(threadId: string): TaskRecord | undefined {
    return this.tasks.get(threadId);
  }

  add(task: TaskRecord): void {
    this.tasks.set(task.threadId, task);
    this.save();
  }

  update(threadId: string, patch: Partial<Pick<TaskRecord, "status" | "lastUpdate" | "agentId">>): TaskRecord | undefined {
    const task = this.tasks.get(threadId);
    if (!task) return undefined;
    if (patch.status) task.status = patch.status;
    if (patch.agentId) task.agentId = patch.agentId;
    if (patch.lastUpdate !== undefined) task.lastUpdate = patch.lastUpdate.trim().slice(0, MAX_LAST_UPDATE_CHARS);
    task.updatedAt = new Date().toISOString();
    this.save();
    return task;
  }

  /** Most recently updated first. */
  list(limit = 15): TaskRecord[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  private save(): void {
    if (this.tasks.size > MAX_TASKS) {
      for (const old of this.list(Infinity).slice(MAX_TASKS)) this.tasks.delete(old.threadId);
    }
    if (!this.file) return;
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify([...this.tasks.values()], null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[tasks] could not save registry: ${err instanceof Error ? err.message : err}`);
    }
  }
}

/** "3 min ago" style age for task listings. */
export function age(iso: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
