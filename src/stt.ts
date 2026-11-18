/**
 * ElevenLabs realtime Speech-to-Text (Scribe) over websocket.
 *
 * One SttSession per utterance: audio is streamed while the user is still
 * speaking and committed when the VAD detects end of speech, so the transcript
 * is ready moments after the user stops. Audio written before the socket is
 * open (or after a dropped connection) is replayed, so no speech is lost.
 *
 * Docs: https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime
 */

import { safeError } from "./redact.js";
import WebSocket from "ws";
import { connectSocket, ElevenLabsError, toIsoLanguage } from "./elevenlabs.js";
import { DailyBudget, type BudgetSnapshot } from "./usage-budget.js";

const REALTIME_PATH = "/v1/speech-to-text/realtime";
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // 16-bit mono
const MAX_CONNECT_ATTEMPTS = 2;
const RECONNECT_DELAY_MS = 200;

const DEFAULT_MODEL = "scribe_v3_live";
const DEFAULT_DAILY_BUDGET_SECONDS = 3600;
const DEFAULT_COMMIT_TIMEOUT_MS = 10_000;
const MAX_KEYTERMS = 50;

export interface STTConfig {
  apiKey: string;
  model?: string;
  /** BCP-47 tag such as "nb-NO". Omit to let Scribe detect the language. */
  language?: string;
  dailyBudgetSeconds?: number;
  /** Upper bound for the transcript to arrive after commit. */
  timeoutMs?: number;
  /** Words to bias recognition towards (names, jargon). At most 50; adds 20% to the STT price. */
  keyterms?: string[];
}

export interface STTUsage extends BudgetSnapshot {
  transcriptions: number;
}

interface SessionOptions {
  apiKey: string;
  model: string;
  language: string | undefined;
  timeoutMs: number;
  keyterms: string[];
}

export class SttSession {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private socket: WebSocket | null = null;
  private live = false; // socket open and buffered audio replayed
  private commitRequested = false;
  private attempts = 0;
  private closed = false;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private settle!: { resolve: (text: string) => void; reject: (err: Error) => void };
  private readonly result: Promise<string>;

  constructor(
    private readonly options: SessionOptions,
    private readonly onClosed: (seconds: number, transcribed: boolean) => void,
  ) {
    this.result = new Promise((resolve, reject) => {
      this.settle = { resolve, reject };
    });
    this.result.catch(() => {}); // surfaced through commit(); avoid unhandled rejection after cancel
    this.connect();
  }

  get durationMs(): number {
    return (this.bytes / BYTES_PER_SECOND) * 1000;
  }

  /** Stream 16 kHz mono 16-bit PCM. */
  write(pcm: Buffer): void {
    if (this.closed || this.commitRequested) return;
    this.chunks.push(pcm);
    this.bytes += pcm.length;
    if (this.live) this.sendAudio(pcm, false);
  }

  /** Signal end of speech and wait for the final transcript (empty string when nothing was recognised). */
  commit(): Promise<string> {
    if (this.closed) return this.result;
    this.commitRequested = true;
    this.timeout = setTimeout(
      () => this.fail(new ElevenLabsError(`STT timeout after ${this.options.timeoutMs}ms`)),
      this.options.timeoutMs,
    );
    if (this.live) this.sendAudio(null, true);
    return this.result;
  }

  /** Abandon the utterance without waiting for a transcript. */
  cancel(): void {
    this.finish(() => this.settle.resolve(""), false);
  }

  private connect(): void {
    this.attempts++;
    const { apiKey, model, language, keyterms } = this.options;
    connectSocket(
      REALTIME_PATH,
      {
        model_id: model,
        audio_format: "pcm_16000",
        commit_strategy: "manual",
        language_code: toIsoLanguage(language),
        keyterms: keyterms.length > 0 ? keyterms : undefined,
      },
      apiKey,
    ).then(
      (socket) => this.attach(socket),
      (err: Error) => this.connectionLost(err),
    );
  }

  private attach(socket: WebSocket): void {
    if (this.closed) {
      socket.close();
      return;
    }
    this.socket = socket;
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("error", () => {}); // 'close' follows and drives recovery
    socket.on("close", () => {
      if (this.socket === socket) this.connectionLost(new ElevenLabsError("STT connection closed"));
    });

    for (const chunk of this.chunks) this.sendAudio(chunk, false);
    this.live = true;
    if (this.commitRequested) this.sendAudio(null, true);
  }

  private connectionLost(err: Error): void {
    this.live = false;
    this.socket = null;
    if (this.closed) return;
    const fatal = err instanceof ElevenLabsError && err.fatal;
    if (fatal || this.attempts >= MAX_CONNECT_ATTEMPTS) {
      this.fail(err);
      return;
    }
    console.error(`[stt] connection lost, retrying: ${safeError(err)}`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closed) this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private sendAudio(pcm: Buffer | null, commit: boolean): void {
    this.socket?.send(
      JSON.stringify({
        message_type: "input_audio_chunk",
        audio_base_64: pcm ? pcm.toString("base64") : "",
        sample_rate: SAMPLE_RATE,
        commit,
      }),
    );
  }

  private onMessage(raw: string): void {
    let message: { message_type?: string; text?: string; error?: string };
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    switch (message.message_type) {
      case "committed_transcript":
        this.finish(() => this.settle.resolve((message.text ?? "").trim()), true);
        break;
      case "insufficient_audio_activity":
        this.finish(() => this.settle.resolve(""), false);
        break;
      case "quota_exceeded":
        this.fail(new ElevenLabsError(message.error ?? "quota exceeded", true, true));
        break;
      case "auth_error":
      case "unaccepted_terms":
      case "invalid_request":
      case "input_error":
        this.fail(new ElevenLabsError(message.error ?? message.message_type, false, true));
        break;
      default:
        if (message.message_type && message.error) {
          this.fail(new ElevenLabsError(`${message.message_type}: ${message.error}`));
        }
    }
  }

  private fail(err: Error): void {
    this.finish(() => this.settle.reject(err), false);
  }

  private finish(settle: () => void, transcribed: boolean): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.onClosed(this.bytes / BYTES_PER_SECOND, transcribed);
    settle();
  }
}

export class SpeechToText {
  private language: string | undefined;
  private readonly budget: DailyBudget;
  private readonly sessions = new Set<SttSession>();
  private transcriptions = 0;
  private disposed = false;

  constructor(private readonly config: STTConfig) {
    this.language = config.language;
    this.budget = new DailyBudget("stt", config.dailyBudgetSeconds ?? DEFAULT_DAILY_BUDGET_SECONDS, "s");
  }

  /** Start a session for one utterance, or null when disposed or the daily budget is used up. */
  open(): SttSession | null {
    if (this.disposed || this.budget.exhausted) return null;
    const session = new SttSession(
      {
        apiKey: this.config.apiKey,
        model: this.config.model ?? DEFAULT_MODEL,
        language: this.language,
        timeoutMs: this.config.timeoutMs ?? DEFAULT_COMMIT_TIMEOUT_MS,
        keyterms: (this.config.keyterms ?? []).slice(0, MAX_KEYTERMS),
      },
      (seconds, transcribed) => {
        this.sessions.delete(session);
        this.budget.add(seconds);
        if (transcribed) this.transcriptions++;
      },
    );
    this.sessions.add(session);
    return session;
  }

  setLanguage(language: string | undefined): void {
    this.language = language;
  }

  get usage(): STTUsage {
    return { ...this.budget.snapshot(), transcriptions: this.transcriptions };
  }

  dispose(): void {
    this.disposed = true;
    for (const session of [...this.sessions]) session.cancel();
  }
}
