import type { SpeechBuffer, SpeechEvent } from "./audio-utils.js";
import type { SpeechToText, SttSession } from "./stt.js";
import type { Brain } from "./brain.js";
import type { Speaker } from "./speaker.js";
import type { WakeGate } from "./gate.js";
import { synthesize } from "./tts.js";
import { SentenceSplitter, toSpeech } from "./split.js";
import { debugLog, debugText, timing } from "./debug.js";
import { redact } from "./policy.js";

/**
 * The conversation loop: microphone -> VAD -> STT -> wake gate -> brain -> sentence
 * streaming -> TTS -> speaker. Owns barge-in, cancellation and ordering.
 *
 * States: listening (idle), thinking (brain running, nothing audible yet), speaking (audio out).
 * Barge-in: speech that lasts `bargeInMs` while the assistant is busy cancels the reply at once.
 * Chunks from a cancelled reply are never played (generation counter).
 * Utterances that end mid-sentence, or that only say the wake word, wait `mergeMs`
 * for the rest of the request.
 */
export type State = "listening" | "thinking" | "speaking";

export interface ConversationDeps {
  buffer: SpeechBuffer;
  stt: SpeechToText;
  brain: Brain;
  speaker: Speaker;
  gate: WakeGate;
  tts: { apiKey: string; voice: string; model: string };
  bargeInMs: number;
  mergeMs: number;
  log: (msg: string) => void;
}

/** Audio for one sentence, filled while the sentence is still being synthesized. */
class ChunkStream {
  private items: Buffer[] = [];
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;

  push(chunk: Buffer): void {
    this.items.push(chunk);
    this.notify();
  }

  end(error?: Error): void {
    this.ended = true;
    this.error = error ?? null;
    this.notify();
  }

  async *chunks(): AsyncGenerator<Buffer> {
    for (;;) {
      if (this.items.length) {
        yield this.items.shift()!;
        continue;
      }
      if (this.ended) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  private notify(): void {
    const w = this.wake;
    this.wake = null;
    w?.();
  }
}

interface Queued {
  stream: ChunkStream;
  generation: number;
}

export class Conversation {
  private generation = 0;
  private turn: AbortController | null = null;
  private session: SttSession | null = null;
  private bargeSince = 0;
  private chain: Promise<void> = Promise.resolve();
  private playback: Promise<void> = Promise.resolve();
  private queue: Queued[] = [];
  private endedAt = 0;
  private reportLatency = false;
  private pending: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;

  constructor(private readonly d: ConversationDeps) {}

  get state(): State {
    if (this.queue.length || this.d.speaker.active) return "speaking";
    if (this.turn) return "thinking";
    return "listening";
  }

  /** Feed microphone PCM (16 kHz mono s16le). Events are processed strictly in order. */
  onMic(pcm: Buffer): void {
    this.chain = this.chain
      .then(() => this.process(pcm))
      .catch((err) => this.d.log(`audio error: ${redact((err as Error).message)}`));
  }

  async shutdown(): Promise<void> {
    this.interrupt("shutdown");
    if (this.pending) clearTimeout(this.pending.timer);
    this.pending = null;
    this.session?.cancel();
    this.session = null;
    this.d.stt.dispose();
  }

  // ---- microphone events -------------------------------------------------

  private async process(pcm: Buffer): Promise<void> {
    for (const e of await this.d.buffer.feed(pcm)) this.onSpeech(e);
  }

  private onSpeech(e: SpeechEvent): void {
    switch (e.type) {
      case "start":
        this.session = this.d.stt.open();
        this.session?.write(e.audio);
        this.bargeSince = this.state !== "listening" ? Date.now() : 0;
        return;
      case "audio":
        this.session?.write(e.audio);
        if (this.bargeSince && e.speech && Date.now() - this.bargeSince >= this.d.bargeInMs) {
          this.bargeSince = 0;
          this.d.log("barge-in: cutting the reply");
          this.interrupt("barge-in");
        }
        return;
      case "end": {
        this.bargeSince = 0;
        this.endedAt = Date.now();
        const session = this.session;
        this.session = null;
        if (e.discard || !session) {
          session?.cancel();
          return;
        }
        session
          .commit()
          .then((text) => this.onUtterance(text.trim()))
          .catch((err) => this.d.log(`transcription failed: ${redact((err as Error).message)}`));
        return;
      }
    }
  }

  // ---- utterances and turns ---------------------------------------------

  private onUtterance(text: string): void {
    debugLog(debugText("stt", text));
    if (!text) return;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      text = `${this.pending.text} ${text}`;
      this.pending = null;
    }
    // admit() opens the conversation window when the name is said, even if nothing else follows.
    if (!this.d.gate.admit(text)) {
      debugLog("not addressed to the assistant; ignored");
      return;
    }
    const command = this.d.gate.strip(text);
    const unfinished = !/[.!?…]$/.test(command);
    if (!command || (unfinished && this.d.mergeMs > 0)) {
      // Wake word alone, or a fragment: wait briefly for the rest before answering.
      this.pending = {
        text,
        timer: setTimeout(() => {
          const p = this.pending;
          this.pending = null;
          if (p) this.handle(p.text);
        }, this.d.mergeMs),
      };
      return;
    }
    this.handle(text);
  }

  private handle(text: string): void {
    const command = this.d.gate.strip(text);
    if (!command) return;
    this.d.gate.extend();
    this.d.log(`heard: ${command}`);
    if (this.state !== "listening") this.interrupt("new utterance");
    this.runTurn(command);
  }

  private runTurn(text: string): void {
    const ctl = new AbortController();
    const gen = this.generation;
    this.turn = ctl;
    const splitter = new SentenceSplitter();
    const say = (sentence: string) => this.enqueue(sentence, ctl, gen);

    this.d.brain
      .respond(
        text,
        {
          onText: (chunk) => {
            for (const s of splitter.push(chunk)) say(s);
          },
          onToolStart: (name) => this.d.log(`tool: ${name}`),
        },
        ctl.signal,
      )
      .then(() => {
        if (ctl.signal.aborted || gen !== this.generation) return;
        for (const s of splitter.flush()) say(s);
        this.d.gate.extend();
      })
      .catch((err) => {
        if (ctl.signal.aborted || gen !== this.generation) return;
        this.d.log(`brain error: ${redact((err as Error).message)}`);
        say("Jeg fikk en feil. Prøv igjen om litt.");
      })
      .finally(() => {
        if (this.turn === ctl) this.turn = null;
        this.idleCheck();
      });
  }

  /** Start synthesizing a sentence now (prefetch) and queue it for in-order playback. */
  private enqueue(sentence: string, ctl: AbortController, gen: number): void {
    const clean = toSpeech(sentence);
    if (!clean || ctl.signal.aborted || gen !== this.generation) return;
    const stream = new ChunkStream();
    const t = this.d.tts;
    void (async () => {
      try {
        for await (const chunk of synthesize(clean, { apiKey: t.apiKey, voice: t.voice, model: t.model, signal: ctl.signal })) {
          stream.push(chunk);
        }
        stream.end();
      } catch (err) {
        if (!ctl.signal.aborted) this.d.log(`speech error: ${redact((err as Error).message)}`);
        stream.end(err as Error);
      }
    })();
    this.queue.push({ stream, generation: gen });
    this.reportLatency = true;
    this.pump();
  }

  /** Play queued sentences in order. Only one playback chain runs at a time. */
  private pump(): void {
    this.playback = this.playback
      .then(async () => {
        while (this.queue.length) {
          const item = this.queue.shift()!;
          if (item.generation !== this.generation) continue;
          for await (const chunk of item.stream.chunks()) {
            if (item.generation !== this.generation) break;
            if (this.reportLatency && this.endedAt) {
              timing(`TURN_LATENCY: ${Date.now() - this.endedAt}ms from end of speech to first audio`);
              this.reportLatency = false;
            }
            this.d.speaker.write(chunk);
          }
        }
      })
      .catch((err) => this.d.log(`playback error: ${redact((err as Error).message)}`))
      .finally(() => this.idleCheck());
  }

  /** When nothing is left to say or play, let the player finish its tail and exit. */
  private idleCheck(): void {
    if (!this.turn && this.queue.length === 0) this.d.speaker.finish();
  }

  /** Cancel the reply and all queued speech, at once. */
  private interrupt(reason: string): void {
    this.generation++;
    this.turn?.abort();
    this.turn = null;
    this.queue = [];
    this.d.speaker.stop();
    debugLog(`interrupt: ${reason}`);
  }
}
