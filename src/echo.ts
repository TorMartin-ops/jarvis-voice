/**
 * Software echo guard and backchannel filter.
 *
 * On speakers, the microphone hears the assistant's own voice. Instead of DSP echo
 * cancellation, transcripts heard while (or just after) the assistant spoke are
 * compared with what it actually said. A close match is its own echo and is ignored.
 * Short acknowledgements ("mm", "ja", "ok") while it talks are backchannels, not requests.
 */

const BACKCHANNELS = new Set([
  "mm", "mmm", "mhm", "mm-hm", "hm", "hmm", "aha", "ah", "å", "åh", "oi",
  "ja", "jaa", "jo", "jepp", "japp", "ok", "okei", "okay", "greit", "fint", "bra",
  "akkurat", "nettopp", "stemmer", "riktig", "skjønner", "jaså", "yes", "yeah", "right",
]);

/** Lowercased words without punctuation or audio tags. */
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** Share of the heard words that also occur in the spoken text (0..1). */
export function overlap(heard: string, spoken: string): number {
  const h = words(heard);
  if (!h.length) return 0;
  const s = new Set(words(spoken));
  let hit = 0;
  for (const w of h) if (s.has(w)) hit++;
  return hit / h.length;
}

/** True when `heard` is most likely the assistant's own voice coming back through the mic. */
export function isEcho(heard: string, recentlySpoken: string[], threshold = 0.6): boolean {
  if (words(heard).length < 2) return false; // too short to tell; handled as a backchannel instead
  const spoken = recentlySpoken.join(" ");
  return overlap(heard, spoken) >= threshold;
}

/** True when the whole utterance is an acknowledgement such as "mm", "ja ja" or "okei, skjønner". */
export function isBackchannel(text: string): boolean {
  const w = words(text);
  return w.length > 0 && w.length <= 3 && w.every((x) => BACKCHANNELS.has(x));
}
