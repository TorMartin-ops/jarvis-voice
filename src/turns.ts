/**
 * Turn-taking heuristics on transcript text.
 *
 * Scribe punctuates its transcripts, so a fragment that ends mid-thought
 * ("Jeg vil bruke V4, selv om det, og-") can be told apart from a finished
 * sentence and held back briefly in case the user carries on.
 */

/** Words that almost never end a finished sentence. Kept short on purpose: prepositions often end questions. */
const CONTINUATION_WORDS = new Set([
  "og", "men", "eller", "fordi", "hvis", "at", "som",
  "eh", "ehm", "ehh", "øh", "øhm", "uh", "um", "uhm",
  "and", "but", "or", "because", "the",
]);

const FILLER = /^(m+|mh?m+|hm+|a+ha+|ah+|å+h*|eh+|øh+|uh+|um+)$/;

const SHORT_ACKS = new Set([
  "ja", "jo", "nei", "ok", "okei", "okay", "jepp", "jada", "javel", "greit", "riktig", "stemmer",
  "akkurat", "nettopp", "sant", "fint", "bra", "kult", "yes", "yeah", "yep", "no", "nope", "right",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
}

/** True when the transcript reads like a finished sentence rather than a fragment cut off by a pause. */
export function looksComplete(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/(-|–|—|,|;|:|\.\.\.|…)$/.test(t)) return false;
  const last = words(t).pop() ?? "";
  if (CONTINUATION_WORDS.has(last)) return false;
  return /[.!?]$/.test(t);
}

/**
 * How an utterance spoken over the bot's own speech should be treated:
 *   filler  "mm", "hm": drop it, keep talking
 *   ack     "ja", "ok": pass it on without interrupting
 *   speech  anything else: a real interruption
 */
export function classifyOverlap(text: string): "filler" | "ack" | "speech" {
  const ws = words(text);
  if (ws.length === 0) return "filler";
  if (ws.every((w) => FILLER.test(w))) return "filler";
  if (ws.length <= 3 && ws.every((w) => SHORT_ACKS.has(w) || FILLER.test(w))) return "ack";
  return "speech";
}
