import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";

/**
 * Long-term memory: a small, capped list of stable facts and preferences that
 * Luna sees on every turn. Kept short on purpose so it never slows the voice path.
 * Tor Martin can ask Luna to remember or forget things; nothing is stored silently.
 */
export interface Fact {
  text: string;
  addedAt: string;
}

const MAX_FACTS = 40;
const MAX_FACT_CHARS = 200;

export class Memory {
  private facts: Fact[] = [];

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(parsed)) this.facts = parsed.filter((f) => typeof f?.text === "string").slice(-MAX_FACTS);
      } catch {
        // A broken memory file must not stop the assistant.
      }
    }
  }

  list(): Fact[] {
    return [...this.facts];
  }

  /** Add a fact. Duplicates (case-insensitive) are ignored. Returns false if it was a duplicate or empty. */
  add(text: string): boolean {
    const clean = text.replace(/\s+/g, " ").trim().slice(0, MAX_FACT_CHARS);
    if (!clean) return false;
    if (this.facts.some((f) => f.text.toLowerCase() === clean.toLowerCase())) return false;
    this.facts.push({ text: clean, addedAt: new Date().toISOString() });
    if (this.facts.length > MAX_FACTS) this.facts = this.facts.slice(-MAX_FACTS);
    this.save();
    return true;
  }

  /** Remove facts containing the phrase (case-insensitive). Returns how many were removed. */
  forget(phrase: string): number {
    const p = phrase.trim().toLowerCase();
    if (!p) return 0;
    const before = this.facts.length;
    this.facts = this.facts.filter((f) => !f.text.toLowerCase().includes(p));
    const removed = before - this.facts.length;
    if (removed) this.save();
    return removed;
  }

  /** The block injected into the system prompt. */
  render(): string {
    if (!this.facts.length) return "";
    return "Det du husker om Tor Martin (bruk når det er relevant):\n" + this.facts.map((f) => `- ${f.text}`).join("\n");
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.facts, null, 2), { mode: 0o600 });
    } catch {
      // best-effort
    }
  }
}
