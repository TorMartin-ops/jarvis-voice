import { Readable } from "stream";

/** Output format of every SpeechStream: 48 kHz stereo signed 16-bit PCM, ready for Discord. */
const BYTES_PER_MS = 48 * 4;
/** Hand audio to the consumer in 40 ms slices so playback progress stays precise. */
const SLICE_BYTES = 40 * BYTES_PER_MS;

/** Thrown through SpeechStream.done when synthesis is cancelled (barge-in). Expected, not an error. */
export class TtsAbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "TtsAbortError";
  }
}

export function isTtsAbort(err: unknown): boolean {
  return err instanceof TtsAbortError;
}

interface Mark {
  endByte: number;
  endChar: number;
}

/**
 * Audio of one spoken reply. Readable on demand, so the bytes handed out
 * track what the player has actually consumed; spokenChars() maps that back
 * to a position in the source text for interruption reporting.
 */
export class SpeechStream extends Readable {
  /** Settles when synthesis ends: resolves on success, rejects on failure or abort. */
  readonly done: Promise<void>;
  /** Called on abort to stop the upstream producer. */
  abortSource: () => void = () => {};

  private settleDone!: (err?: Error) => void;
  private pending: Buffer = Buffer.alloc(0);
  private wantsData = false;
  private inputEnded = false;
  private endPushed = false;
  private aborted = false;
  private fedBytes = 0;
  private fedChars = 0;
  private deliveredBytes = 0;
  private readonly marks: Mark[] = [];

  constructor() {
    super({ highWaterMark: SLICE_BYTES });
    this.done = new Promise((resolve, reject) => {
      this.settleDone = (err) => (err ? reject(err) : resolve());
    });
    this.done.catch(() => {}); // consumers opt in to errors via `done`
  }

  get hasAudio(): boolean {
    return this.fedBytes > 0;
  }

  get cancelled(): boolean {
    return this.aborted;
  }

  /** Append audio together with the number of source characters it covers. */
  append(pcm: Buffer, chars: number): void {
    if (this.inputEnded) return;
    const first = this.fedBytes === 0;
    this.pending = this.pending.length > 0 ? Buffer.concat([this.pending, pcm]) : pcm;
    this.fedBytes += pcm.length;
    this.fedChars += chars;
    this.marks.push({ endByte: this.fedBytes, endChar: this.fedChars });
    if (first) this.emit("firstAudio");
    this.pump();
  }

  finish(err?: Error): void {
    if (this.inputEnded) return;
    this.inputEnded = true;
    this.settleDone(err);
    this.pump();
  }

  abort(): void {
    if (this.inputEnded) return;
    this.aborted = true;
    this.pending = Buffer.alloc(0);
    this.abortSource();
    this.finish(new TtsAbortError());
  }

  /** Characters of the source text covered by the audio handed to the player so far. */
  spokenChars(): number {
    let prevByte = 0;
    let prevChar = 0;
    for (const mark of this.marks) {
      if (this.deliveredBytes <= mark.endByte) {
        const span = mark.endByte - prevByte;
        const fraction = span > 0 ? (this.deliveredBytes - prevByte) / span : 1;
        return Math.round(prevChar + fraction * (mark.endChar - prevChar));
      }
      prevByte = mark.endByte;
      prevChar = mark.endChar;
    }
    return this.fedChars;
  }

  override _read(): void {
    this.wantsData = true;
    this.pump();
  }

  private pump(): void {
    while (this.wantsData) {
      if (this.pending.length === 0) {
        if (this.inputEnded && !this.endPushed) {
          this.endPushed = true;
          this.push(null);
        }
        return;
      }
      const slice = this.pending.subarray(0, SLICE_BYTES);
      this.pending = this.pending.subarray(slice.length);
      this.deliveredBytes += slice.length;
      this.wantsData = this.push(slice);
    }
  }
}
