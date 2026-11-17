/**
 * Speaker allowlist.
 *
 * Only Discord users on the allowlist are ever listened to. Audio from anyone
 * else is neither subscribed to nor sent to ElevenLabs. With no allowlist
 * configured, nobody is allowed (deny by default).
 *
 * Sources, merged:
 *   - VOICE_ALLOWED_USERS: comma-separated Discord user IDs (env or the voice .env)
 *   - ~/.claude/channels/discord/access.json written by the Discord text plugin
 *     (its `allowFrom` list of user IDs). Unknown or malformed files are ignored.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export const SNOWFLAKE = /^\d{17,20}$/;

const ACCESS_FILE = join(homedir(), ".claude", "channels", "discord", "access.json");
const CACHE_MS = 5_000;

export interface AllowlistInfo {
  ids: string[];
  fromEnv: number;
  fromAccessFile: number;
  accessFilePath: string;
}

let cache: { at: number; info: AllowlistInfo } | null = null;

/**
 * Parse JSON while keeping large integers intact. Snowflakes are 17-20 digits
 * and exceed Number.MAX_SAFE_INTEGER, so JSON.parse would silently round them.
 * Bare integers with 16 or more digits are rewritten to strings before parsing;
 * quoted strings are skipped by the tokenizer so their contents are untouched.
 */
export function parseJsonKeepingBigInts(text: string): unknown {
  const token = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
  const rewritten = text.replace(token, (m) => (/^\d{16,}$/.test(m) ? `"${m}"` : m));
  return JSON.parse(rewritten);
}

/** Keep only well-formed snowflake strings. Other numbers are rejected (they may have lost precision). */
export function parseIds(values: unknown[], source = "allowlist"): string[] {
  const out: string[] = [];
  for (const v of values) {
    if (typeof v === "string") {
      const s = v.trim().replace(/\r$/, "");
      if (SNOWFLAKE.test(s)) out.push(s);
    } else if (typeof v === "number") {
      console.error(`[access] ignoring numeric ID in ${source}: write Discord IDs as strings ("123...") to avoid precision loss`);
    }
  }
  return out;
}

function readAccessFile(): string[] {
  try {
    const data = parseJsonKeepingBigInts(readFileSync(ACCESS_FILE, "utf8"));
    if (data && typeof data === "object" && Array.isArray((data as { allowFrom?: unknown }).allowFrom)) {
      return parseIds((data as { allowFrom: unknown[] }).allowFrom, "access.json");
    }
  } catch {
    // missing or unreadable: no entries
  }
  return [];
}

export function loadAllowlist(): AllowlistInfo {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.info;
  const env = parseIds((process.env.VOICE_ALLOWED_USERS ?? "").split(/[,\s]+/), "VOICE_ALLOWED_USERS");
  const file = readAccessFile();
  const info: AllowlistInfo = {
    ids: [...new Set([...env, ...file])],
    fromEnv: env.length,
    fromAccessFile: file.length,
    accessFilePath: ACCESS_FILE,
  };
  cache = { at: now, info };
  return info;
}

export function isAllowedSpeaker(userId: string): boolean {
  return SNOWFLAKE.test(userId) && loadAllowlist().ids.includes(userId);
}

export function allowlistHelp(): string {
  return (
    "No allowed speakers are configured, so voice input is ignored. Add Discord user IDs to " +
    "VOICE_ALLOWED_USERS (comma-separated) in ~/.claude/channels/discord-voice/.env, or allow users " +
    "with the Discord text plugin (~/.claude/channels/discord/access.json, allowFrom)."
  );
}
