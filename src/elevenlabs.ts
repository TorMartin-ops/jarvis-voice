import WebSocket from "ws";
import { safeError } from "./redact.js";

export const API_HOST = "api.elevenlabs.io";
const CONNECT_TIMEOUT_MS = 8_000;

export class ElevenLabsError extends Error {
  constructor(
    message: string,
    /** True when the account's character or audio quota is used up. */
    readonly quotaExceeded = false,
    /** True when retrying cannot help (bad key, quota, invalid request). */
    readonly fatal = false,
  ) {
    super(message);
    this.name = "ElevenLabsError";
  }
}

/** Reduce a BCP-47 tag ("nb-NO") to the ISO 639-1 code ElevenLabs expects ("no"). */
export function toIsoLanguage(tag: string | undefined): string | undefined {
  const primary = tag?.split(/[-_]/)[0]?.toLowerCase();
  if (!primary) return undefined;
  return primary === "nb" || primary === "nn" ? "no" : primary;
}

/** Open an authenticated ElevenLabs websocket and resolve once it is open. */
export function connectSocket(
  path: string,
  params: Record<string, string | string[] | undefined>,
  apiKey: string,
): Promise<WebSocket> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const item of value) query.append(key, item);
    else if (value !== undefined) query.set(key, value);
  }
  const socket = new WebSocket(`wss://${API_HOST}${path}?${query}`, {
    headers: { "xi-api-key": apiKey },
    handshakeTimeout: CONNECT_TIMEOUT_MS,
  });

  return new Promise((resolve, reject) => {
    socket.once("open", () => {
      socket.removeAllListeners("error");
      socket.removeAllListeners("unexpected-response");
      // Permanent handler: a late protocol error on a pooled socket must never
      // become an uncaught exception. 'close' drives recovery in the callers.
      socket.on("error", (err) => console.error(`[elevenlabs] socket error: ${safeError(err)}`));
      resolve(socket);
    });
    socket.once("error", (err) => reject(new ElevenLabsError(safeError(err))));
    socket.once("unexpected-response", (_req, res) => {
      socket.terminate();
      const status = res.statusCode ?? 0;
      reject(
        new ElevenLabsError(
          `ElevenLabs rejected the connection (HTTP ${status})`,
          false,
          status === 401 || status === 403,
        ),
      );
    });
  });
}
