import type { SpeechBuffer, SpeechEvent } from "./audio-utils.js";
import type { SpeechToText, SttSession } from "./stt.js";
import type { Brain } from "./brain.js";
import type { Speaker } from "./speaker.js";
import type { WakeGate } from "./gate.js";
import { synthesize } from "./tts.js";
import { SentenceSplitter, toSpeech, sanitizeTags, stripTags } from "./split.js";
import { isEcho, isBackchannel, isStopCommand } from "./echo.js";
import { debugLog, debugText, timing } from "./debug.js";
import { redact } from "./policy.js";

/**
 * The conversation loop: microphone -> VAD -> STT -> wake gate -> brain -> sentence
 * streaming -> TTS -> speaker. Owns barge-in, cancellation and ordering.
 *
 * States: listening (idle), thinking (brain running, nothing audible yet), speaking (audio out).
 * Barge-in (headset): speech that lasts `bargeInMs` while the assistant is busy cancels the reply at once.
 * Half duplex (speakers): the mic hears the reply, and a misheard echo slips past the text-based
 * echo guard, so while the assistant is audible (and ECHO_TAIL_MS after) only its name, said by
 * someone other than itself, gets through. Speech that runs on past the reply is cut where the
 * reply ended, and the rest is handled as a fresh utterance.
 * A bare stop command ("stopp", "hysj") silences the reply without starting a new turn.
 * Chunks from a cancelled reply are never played (generation counter).
 * Utterances that end mid-sentence, or that only say the wake word, wait `mergeMs`
 * for the rest of the request.
 */
export type State = "listening" | "thinking" | "speaking";

/** How long after the last audible reply the mic may still hear it (player and device buffers, room). */
export const ECHO_TAIL_MS = 600;

export interface ConversationDeps {
  buffer: SpeechBuffer;
  stt: SpeechToText;
  brain: Brain;
  speaker: Speaker;
  gate: WakeGate;
  tts: { apiKey: string; voice: string; model: string };
  bargeInMs: number;
  mergeMs: number;
  /** headset: talking over the reply cuts it after bargeInMs. speakers: only a real transcript cuts it (echo-safe). */
  audioMode: "headset" | "speakers";
  /** Optional tap on every PCM chunk sent to the speaker (24 kHz mono s16le). Used by tests. */
  onAudioOut?: (pcm: Buffer) => void;
  /** Text-to-speech function; defaults to ElevenLabs. Tests pass a fake. */
  synth?: typeof synthesize;
  /** Called at the start of every turn with what Tor Martin said ("" for report turns). */
  onUserTurn?: (text: string, previousReply: string) => void;
  /** Quiet time to wait after each utterance before answering (a study session: long answers with pauses). */
  patienceMs?: () => number;
  /** Treat all speech as addressed to the assistant, without the wake word (a study session). */
  alwaysListen?: () => boolean;
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
  /** Milliseconds after the end of speech for each step of the current reply (for TURN_LATENCY). */
  private marks: { stt?: number; sentence?: number; tts?: number } = {};
  private reportLatency = false;
  private pending: { text: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** What the assistant said recently (words only), for the echo guard. */
  private recentSpoken: { text: string; at: number }[] = [];
  /** When the audio written so far will have finished playing (wall clock). Writes run ahead of playback. */
  private playbackEndsAt = 0;
  /** Audio tags that arrived as their own "sentence"; they are put in front of the next one. */
  private carryTags = "";
  /** Words spoken in the current turn, and in the turn before (for the confirmation gate). */
  private replyNow = "";
  private replyBefore = "";
  /** Last time the assistant was seen speaking, for the half-duplex tail. */
  private speakingSeenAt = 0;
  /** The open STT session began (or ran) while the reply was audible. */
  private sessionOverlaps = false;

  constructor(private readonly d: ConversationDeps) {}

  private get halfDuplex(): boolean {
    return this.d.audioMode === "speakers";
  }

  /** True while the reply is audible, and for ECHO_TAIL_MS after, when the mic may still hear it. */
  private replyAudible(now = Date.now()): boolean {
    if (this.state === "speaking") {
      this.speakingSeenAt = now;
      return true;
    }
    return now - this.speakingSeenAt < ECHO_TAIL_MS;
  }

  get state(): State {
    if (this.queue.length || this.d.speaker.active || Date.now() < this.playbackEndsAt) return "speaking";
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

  /**
   * Something happened that Luna should tell Tor Martin about (a task finished).
   * The note goes into Luna's context at once; she speaks about it as soon as the
   * conversation is idle, unless he talks first (then she sees it in that turn).
   */
  announce(note: string): void {
    this.d.brain.note(note);
    this.announcePending = true;
    this.tryAnnounce();
  }

  /** Greet Tor Martin at start-up, in character and aware of the time of day. */
  greet(now = new Date()): void {
    const time = now.toLocaleTimeString("nb-NO", { hour: "2-digit", minute: "2-digit" });
    const day = now.toLocaleDateString("nb-NO", { weekday: "long" });
    this.announce(`[Oppstart] Klokka er ${time} på en ${day}. Hils kort på Tor Martin i én setning, gjerne med en lun kommentar om tidspunktet. Ikke ramse opp hva du kan.`);
  }

  private announcePending = false;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;

  private tryAnnounce(): void {
    if (!this.announcePending) return;
    if (this.state === "listening" && !this.session && !this.pending) {
      this.announcePending = false;
      this.runTurn(null);
      return;
    }
    if (!this.announceTimer) {
      this.announceTimer = setTimeout(() => {
        this.announceTimer = null;
        this.tryAnnounce();
      }, 500);
    }
  }

  // ---- microphone events -------------------------------------------------

  private async process(pcm: Buffer): Promise<void> {
    this.replyAudible(); // keeps the half-duplex tail measured from the real end of the reply
    for (const e of await this.d.buffer.feed(pcm)) this.onSpeech(e);
  }

  private onSpeech(e: SpeechEvent): void {
    switch (e.type) {
      case "start":
        this.session = this.d.stt.open();
        debugLog(this.session ? "vad: speech started" : "vad: speech started, but speech-to-text refused a session (daily budget used up?)");
        this.session?.write(e.audio);
        this.sessionOverlaps = this.halfDuplex && this.replyAudible();
        // On speakers the mic hears the reply itself, so only a transcript may cut it (see onUtterance).
        this.bargeSince = this.d.audioMode === "headset" && this.state !== "listening" ? Date.now() : 0;
        return;
      case "audio":
        if (this.sessionOverlaps && !this.replyAudible()) {
          // The reply has ended but the speech goes on: drop what was heard over the reply (mostly
          // its echo) and transcribe the rest on its own, so an answer right after the reply counts.
          this.session?.cancel();
          this.session = this.d.stt.open();
          this.sessionOverlaps = false;
          debugLog("half duplex: dropped the speech heard during the reply");
        }
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
        const overlapped = this.sessionOverlaps || (this.halfDuplex && this.replyAudible());
        this.sessionOverlaps = false;
        const session = this.session;
        this.session = null;
        if (e.discard || !session) {
          if (e.discard) debugLog("vad: too short or mostly noise; discarded");
          session?.cancel();
          return;
        }
        const endedAt = this.endedAt;
        this.transcribing++;
        session
          .commit()
          .then((text) => {
            this.transcribing--;
            this.marks = { stt: Date.now() - endedAt };
            this.onUtterance(text.trim(), overlapped);
          })
          .catch((err) => {
            this.transcribing--;
            this.d.log(`transcription failed: ${redact((err as Error).message)}`);
          });
        return;
      }
    }
  }

  // ---- utterances and turns ---------------------------------------------

  /**
   * A finished transcript. `overlapped`: the speech was heard while the reply was audible (speakers
   * only). Direct callers (tests) get it from the current state.
   */
  private onUtterance(text: string, overlapped = this.halfDuplex && this.replyAudible()): void {
    debugLog(debugText("stt", text));
    if (!text) return;
    // While the assistant talks (or just after), ignore its own echo and simple acknowledgements.
    const now = Date.now();
    const spoken = this.recentSpoken.filter((s) => now - s.at < 30_000).map((s) => s.text);
    // Echo can reach the transcript up to a few seconds after the last sound (VAD end + STT).
    if (overlapped || this.state === "speaking" || now < this.playbackEndsAt + 4000) {
      if (isEcho(text, spoken)) {
        debugLog("echo of own voice ignored");
        return;
      }
      if (isBackchannel(text)) {
        debugLog("backchannel ignored");
        return;
      }
    }
    if (overlapped) {
      // Half duplex: over the reply only the assistant's name gets through, and not when the
      // name is in what it just said itself (its own "Claude" or "Jarvis" coming back).
      const own = new Set(this.d.gate.names(spoken.join(" ")));
      if (!this.d.gate.names(text).some((n) => !own.has(n))) {
        debugLog("half duplex: speech during the reply ignored");
        return;
      }
      if (this.state !== "listening") this.interrupt("name said during the reply");
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      text = `${this.pending.text} ${text}`;
      this.pending = null;
    }
    // admit() opens the conversation window when the name is said, even if nothing else follows.
    // In a study session everything he says is for the examiner.
    if (!this.d.alwaysListen?.() && !this.d.gate.admit(text)) {
      debugLog("not addressed to the assistant; ignored");
      return;
    }
    const command = this.d.gate.strip(text);
    if (isStopCommand(command)) {
      if (this.state !== "listening") this.interrupt("stop command");
      this.d.log("stopped");
      return;
    }
    // Very short pieces ("Hei.") are usually the start of a longer request, even with a full stop.
    const words = command.split(/\s+/).filter(Boolean).length;
    const unfinished = words <= 2 || !/[.!?…]$/.test(command);
    // In a study session answers are long and come with pauses: wait for the whole answer,
    // unless he says he is done.
    const patience = this.d.patienceMs?.() ?? 0;
    const done = patience > 0 && /(^|[\s,])(ferdig|det var alt|det var det)[.!]?$/i.test(command);
    let wait = 0;
    if (!command || (unfinished && this.d.mergeMs > 0)) wait = Math.max(this.d.mergeMs, patience);
    else if (patience > 0 && !done) wait = patience;
    if (wait > 0 || !command) {
      // Wake word alone, a fragment, or a long answer: wait for the rest before answering.
      this.holdForMore(text, wait);
      return;
    }
    this.handle(text);
  }

  /** Utterances being transcribed right now (between the end of speech and the transcript). */
  private transcribing = 0;

  /**
   * Keep `text` and answer it after `ms` of quiet. While he is still talking, or the next piece is
   * being transcribed, keep waiting, so the pieces are merged instead of answered one by one.
   */
  private holdForMore(text: string, ms: number): void {
    if (this.pending) clearTimeout(this.pending.timer);
    const fire = () => {
      const p = this.pending;
      if (!p) return;
      if (this.session || this.transcribing > 0) {
        p.timer = setTimeout(fire, 250);
        return;
      }
      this.pending = null;
      this.handle(p.text);
    };
    this.pending = { text, timer: setTimeout(fire, ms) };
  }

  private handle(text: string): void {
    const command = this.d.gate.strip(text);
    if (!command) return;
    this.d.gate.extend();
    this.d.log(`heard: ${command}`);
    if (this.state !== "listening") this.interrupt("new utterance");
    this.announcePending = false; // Luna sees any pending note in this turn
    this.runTurn(command);
  }

  private runTurn(text: string | null): void {
    const ctl = new AbortController();
    const gen = this.generation;
    this.turn = ctl;
    this.replyBefore = this.replyNow;
    this.replyNow = "";
    this.d.onUserTurn?.(text ?? "", this.replyBefore);
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
        // A reply keeps an open conversation going, but a greeting or task report does not open
        // the window on its own: then the room's talk would reach Luna without anyone naming her.
        if (this.d.gate.open) this.d.gate.extend();
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
    if (ctl.signal.aborted || gen !== this.generation) return;
    let clean = sanitizeTags(toSpeech(sentence));
    const spokenWords = stripTags(clean);
    if (!spokenWords) {
      // A tag on its own ("[laughs]") belongs to the next sentence.
      this.carryTags = sanitizeTags(`${this.carryTags} ${clean}`);
      return;
    }
    if (this.carryTags) {
      clean = sanitizeTags(`${this.carryTags} ${clean}`);
      this.carryTags = "";
    }
    debugLog(debugText("say", clean));
    this.replyNow = `${this.replyNow} ${spokenWords}`.trim();
    this.recentSpoken.push({ text: spokenWords, at: Date.now() });
    if (this.recentSpoken.length > 12) this.recentSpoken.shift();
    const stream = new ChunkStream();
    const t = this.d.tts;
    const first = this.endedAt > 0 && this.marks.sentence === undefined;
    if (first) this.marks.sentence = Date.now() - this.endedAt;
    void (async () => {
      try {
        for await (const chunk of (this.d.synth ?? synthesize)(clean, { apiKey: t.apiKey, voice: t.voice, model: t.model, signal: ctl.signal })) {
          if (first && this.marks.tts === undefined && this.endedAt) this.marks.tts = Date.now() - this.endedAt;
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
              const m = this.marks;
              const steps = [m.stt !== undefined && `stt ${m.stt}`, m.sentence !== undefined && `first sentence ${m.sentence}`, m.tts !== undefined && `tts first audio ${m.tts}`].filter(Boolean).join(", ");
              timing(`TURN_LATENCY: ${Date.now() - this.endedAt}ms from end of speech to first audio${steps ? ` (${steps})` : ""}`);
              this.marks = {};
              this.reportLatency = false;
              this.endedAt = 0; // measure only replies to speech, not later announcements
            }
            this.d.speaker.write(chunk);
            // 24 kHz mono s16le = 48 bytes per millisecond of sound.
            this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now()) + chunk.length / 48;
            this.d.onAudioOut?.(chunk);
          }
        }
      })
      .catch((err) => this.d.log(`playback error: ${redact((err as Error).message)}`))
      .finally(() => this.idleCheck());
  }

  /** When nothing is left to say or play, let the player finish its tail and exit. */
  private idleCheck(): void {
    if (!this.turn && this.queue.length === 0) {
      this.d.speaker.finish();
      this.tryAnnounce();
    }
  }

  /** Cancel the reply and all queued speech, at once. */
  private interrupt(reason: string): void {
    const wasBusy = this.state !== "listening";
    this.generation++;
    this.turn?.abort();
    this.turn = null;
    this.queue = [];
    this.carryTags = "";
    this.d.speaker.stop();
    this.playbackEndsAt = 0;
    if (wasBusy && reason !== "shutdown") this.d.brain.note("Du ble avbrutt. Resten av forrige svar ble ikke hørt.");
    debugLog(`interrupt: ${reason}`);
  }
}
