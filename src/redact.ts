/** Keeps credentials out of logs, tool results and error messages. */

const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join("[redacted]");
  return out
    .replace(/xi-api-key["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "xi-api-key=[redacted]")
    .replace(/([?&](?:xi-api-key|api_key|token|authorization)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/\b[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}\b/g, "[redacted-discord-token]");
}

/** A safe one-line description of an unknown error (message only, redacted). */
export function safeError(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}
