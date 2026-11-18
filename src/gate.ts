/**
 * Wake-word gate. Speech reaches the assistant only when it names the assistant,
 * or during a conversation window that opens with a name and stays open for
 * `windowMs` after each addressed utterance or reply.
 */
export class WakeGate {
  private until = 0;
  private readonly re: RegExp | null;

  constructor(
    words: string[],
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {
    const clean = words.map((w) => w.trim().toLowerCase()).filter(Boolean);
    this.re = clean.length
      ? new RegExp(`(^|[^\\p{L}])(${clean.map(escapeRe).join("|")})(?=[^\\p{L}]|$)`, "iu")
      : null;
  }

  /** True when the utterance should be handled. Naming the assistant opens the window. */
  admit(text: string): boolean {
    if (!this.re) return true;
    if (this.mentions(text)) {
      this.extend();
      return true;
    }
    return this.open;
  }

  /** True when the text contains one of the wake words. */
  mentions(text: string): boolean {
    return this.re !== null && this.re.test(text);
  }

  /** The wake words in the text, lowercased, in order. */
  names(text: string): string[] {
    if (!this.re) return [];
    return [...text.matchAll(new RegExp(this.re.source, "giu"))].map((m) => m[2].toLowerCase());
  }

  /** The text with the wake words removed, trimmed of stray punctuation. Empty when only the name was said. */
  strip(text: string): string {
    if (!this.re) return text.trim();
    const globalRe = new RegExp(this.re.source, "giu");
    return text
      .replace(globalRe, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s,.!?:;-]+/, "")
      .trim();
  }

  /** Keep the window open. Called on each addressed utterance and after a reply, so a live conversation does not time out. */
  extend(): void {
    if (this.re) this.until = this.now() + this.windowMs;
  }

  get open(): boolean {
    return !this.re || this.now() < this.until;
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
