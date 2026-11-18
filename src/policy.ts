/**
 * Safety policy for tools the voice assistant may run on this PC.
 * Enforced in code, not only in the prompt. A blocked call returns a message the
 * model must relay, so Tor Martin can confirm and run the step himself.
 */

/** Shell commands that change the outside world or destroy data. */
const BLOCKED_COMMANDS: RegExp[] = [
  /\bgit\s+(push|reset\s+--hard|clean|branch\s+-D)/i,
  /\bRemove-Item\b.*-Recurse/i,
  /\brm\s+-[a-z]*r/i,
  /\b(rmdir|rd)\s+\/s/i,
  /\bdel\s+\/[sq]/i,
  /\bformat\s+[a-z]:/i,
  /\bSend-MailMessage\b/i,
  /\b(curl|Invoke-WebRequest|Invoke-RestMethod|wget)\b.*(-X\s*(POST|PUT|DELETE|PATCH)|-Method\s+(Post|Put|Delete|Patch)|\s-d\s|--data)/i,
  /\breg\s+(add|delete)\b/i,
  /\b(shutdown|Restart-Computer|Stop-Computer)\b/i,
  /\bnet\s+user\b/i,
  /\bsetx\b/i,
  /\bStop-Process\b.*-Force/i,
  /\bnpm\s+publish\b/i,
];

/** Returns a block message, or null when the call may run. */
export function checkTool(name: string, args: Record<string, unknown>, workerCwd: string): string | null {
  if (name === "Bash" || name === "PowerShell") {
    const command = String(args.command ?? "");
    const hit = BLOCKED_COMMANDS.find((re) => re.test(command));
    if (hit) {
      return "BLOCKED: this command needs Tor Martin's explicit confirmation. Tell him what it would do, and let him run it himself if he wants it done.";
    }
  }
  if (name === "Write" || name === "Edit") {
    const path = String(args.file_path ?? args.path ?? "");
    if (!path) return "BLOCKED: no file path given.";
    if (!isInside(path, workerCwd)) return `BLOCKED: writes are only allowed inside ${workerCwd}.`;
  }
  return null;
}

/** True when `path` (absolute, or relative to `root`) lies inside `root`. Rejects `..` escapes. */
export function isInside(path: string, root: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const joined = /^([a-zA-Z]:|\/)/.test(path) ? path : `${root}/${path}`;
  const parts: string[] = [];
  for (const seg of norm(joined).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  const target = parts.join("/");
  const base = norm(root);
  return target === base || target.startsWith(base + "/");
}

/** Remove likely secrets before anything is written to a log. */
export function redact(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-[redacted]")
    .replace(/((?:api[_-]?key|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[redacted]")
    .replace(/\b[MN][A-Za-z0-9_-]{23}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27}\b/g, "[redacted-token]");
}
