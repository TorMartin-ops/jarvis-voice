/**
 * Cut streamed text into speakable sentences. A sentence ends at . ! ? followed
 * by whitespace, or at a newline. A trailing fragment without a boundary is held
 * until more text arrives or `flush()` is called, so nothing is lost.
 */
export class SentenceSplitter {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];
    const boundary = /[.!?]+\s+|\n+/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = boundary.exec(this.buffer)) !== null) {
      const sentence = this.buffer.slice(last, match.index + match[0].length).trim();
      if (sentence) out.push(sentence);
      last = match.index + match[0].length;
    }
    this.buffer = this.buffer.slice(last);
    return out;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest ? [rest] : [];
  }
}

const ONES = ["null", "en", "to", "tre", "fire", "fem", "seks", "sju", "åtte", "ni"];
const TEENS = ["ti", "elleve", "tolv", "tretten", "fjorten", "femten", "seksten", "sytten", "atten", "nitten"];
const TENS = ["", "", "tjue", "tretti", "førti", "femti", "seksti", "sytti", "åtti", "nitti"];

/** A two-digit group the way Norwegians read standard numbers: "84" -> "åttifire", "05" -> "null fem". */
function pairWords(p: string): string {
  if (p.length === 1) return ONES[+p];
  if (p[0] === "0") return `null ${ONES[+p[1]]}`;
  const n = +p;
  if (n < 20) return TEENS[n - 10];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ONES[n % 10] : "");
}

/**
 * Standard numbers spoken the Norwegian way, in pairs: "NS 8405" -> "NS åttifire null fem",
 * "NS 3720" -> "NS trettisju tjue", "NLM 19" -> "NLM nitten". Done in code, because the model
 * gets the digits wrong when it spells them out itself.
 */
export function speakStandards(text: string): string {
  return text
    .replace(/\b(NS(?:-EN)?|NLM|NL|NS-ISO)\s?(\d{2,4})\b/g, (_m, name: string, num: string) => {
      const pairs = num.length === 3 ? [num[0], num.slice(1)] : num.match(/\d{1,2}/g)!;
      return `${name} ${pairs.map(pairWords).join(" ")}`;
    })
    .replace(/§§\s?/g, "paragrafene ")
    .replace(/§\s?/g, "paragraf ")
    .replace(/\s?‰/g, " promille");
}

/** Remove markdown that would be read aloud or distort speech: emphasis, code ticks, headings, bullets, links. */
export function toSpeech(text: string): string {
  return speakStandards(text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, "")
    // File paths are unreadable aloud: keep only the last part ("C:\Users\x\jarvis-voice" -> "jarvis-voice").
    .replace(/[A-Za-z]:\\(?:[^\s\\,;"«»()]+\\)*([^\s\\,;"«»()]*[^\s\\,;"«»().])/g, "$1")
    .replace(/~\/(?:[^\s/,;"«»()]+\/)*([^\s/,;"«»()]*[^\s/,;"«»().])/g, "$1")
    // Say e-mail addresses the Norwegian way instead of letting the voice guess at "@" and ".".
    .replace(/([\w.+-]+)@([\w-]+(?:\.[\w-]+)+)/g, (_m, user: string, domain: string) =>
      `${user} krøllalfa ${domain.split(".").join(" punktum ")}`)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * ElevenLabs audio tags that eleven_v4 / v4 turbo documents as supported. Anything else in
 * square brackets is removed, so an invented tag is never read aloud.
 */
export const AUDIO_TAGS = new Set([
  "laughs", "laughs harder", "starts laughing", "sighs", "exhales", "whispers",
  "curious", "excited", "sarcastic", "mischievously", "short pause", "long pause",
]);
const TAG_ALIASES: Record<string, string> = {
  giggles: "laughs", giggle: "laughs", laugh: "laughs", chuckles: "laughs", chuckle: "laughs",
  sigh: "sighs", pause: "short pause", whisper: "whispers",
};

/** Keep supported audio tags (normalized), drop unknown ones. At most `max` tags per sentence. */
export function sanitizeTags(text: string, max = 1): string {
  let kept = 0;
  return text
    .replace(/\[([^\]]{1,30})\]/g, (_m, raw: string) => {
      const tag = TAG_ALIASES[raw.trim().toLowerCase()] ?? raw.trim().toLowerCase();
      if (!AUDIO_TAGS.has(tag) || kept >= max) return " ";
      kept++;
      return `[${tag}]`;
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** The sentence without audio tags (what will actually be heard as words). */
export function stripTags(text: string): string {
  return text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
}
