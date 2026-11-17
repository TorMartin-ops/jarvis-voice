/**
 * Voice pipeline: Discord audio in -> VAD -> realtime STT -> callback,
 * and spoken replies out through streaming TTS.
 *
 * Listening never pauses. Each user's own Discord stream is captured (the
 * bot's audio is not part of it), so there is no echo to guard against.
 *
 * Barge-in is soft: when the user starts talking over a reply, the reply is
 * ducked, and only cut off once they have kept talking for a moment (or
 * their short utterance turns out to be more than "mm"). The next transcript
 * then tells Claude where it was cut off.
 *
 * Turns are merged: a transcript that ends mid-thought ("..., og-") or that
 * arrives while the user is already speaking again is held back and joined
 * with what follows, so one thought reaches Claude as one message.
 */

import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  entersState,
  EndBehaviorType,
  VoiceConnectionStatus,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import { Client, type VoiceChannel, type StageChannel, type GuildMember } from "discord.js";
import { Readable } from "stream";
import { createOpusDecoder, createDownsampler, SpeechBuffer, VAD_FRAME_MS, type SpeechEvent } from "./audio-utils.js";
import { debugLog, debugText, timing } from "./debug.js";
import { classifyOverlap, looksComplete } from "./turns.js";
import { isAllowedSpeaker, loadAllowlist, allowlistHelp } from "./access.js";
import { safeError } from "./redact.js";
import { ElevenLabsError } from "./elevenlabs.js";
import { describeInterruption, Playback } from "./playback.js";
import { SpeechToText, type SttSession, type STTUsage } from "./stt.js";
import { TextToSpeech } from "./tts.js";
import type { BudgetSnapshot } from "./usage-budget.js";

const DEFAULT_INACTIVITY_TIMEOUT_MS = 600_000; // 10 minutes
const USAGE_LOG_INTERVAL_MS = 60_000;
const MAX_STT_REQUESTS_PER_MINUTE_PER_USER = 60;
const DEFAULT_MERGE_MS = 800;
const DEFAULT_BARGE_IN_MS = 300;
/** Never hold fragments back for longer than this in total. */
const MAX_MERGE_MS = 20_000;
const OVERLAP_ACK_NOTE = "[Said while you were still talking; you were not interrupted]";

/** A 20ms silent Opus frame. Discord only forwards audio to bots that transmit. */
const SILENT_OPUS_FRAME = Buffer.from([0xf8, 0xff, 0xfe]);

export interface VoicePipelineConfig {
  elevenLabsApiKey: string;
  sttModel?: string;
  ttsModel?: string;
  /** BCP-47 tag. Omit for automatic language detection. */
  language?: string;
  /** ElevenLabs voice_id. */
  voice?: string;
  inactivityTimeoutMs?: number;
  sttTimeoutMs?: number;
  /** Words to bias speech recognition towards (names, jargon). */
  sttKeyterms?: string[];
  /** Trailing silence that ends an utterance. Longer values split sentences less often but answer later. */
  endSilenceMs?: number;
  /** Short filler spoken when Claude has not started answering within `delayMs`. */
  backchannel?: { text: string; delayMs: number };
  /** How long to wait for more speech after a fragment that ends mid-thought. */
  mergeMs?: number;
  /** Voiced speech over a reply (after confirmation) before it is cut off. 0 cuts off at once. */
  bargeInMs?: number;
  sttDailySeconds?: number;
  ttsDailyChars?: number;
}

export type TranscriptionCallback = (
  userId: string,
  username: string,
  text: string,
  channelId: string,
) => void;

interface Listener {
  userId: string;
  stream: Readable;
  decoder: ReturnType<typeof createOpusDecoder>;
  downsampler: ReturnType<typeof createDownsampler>;
  speechBuffer: SpeechBuffer;
  /** Serializes async VAD work so audio is processed in order. */
  chain: Promise<void>;
  idleTimer: ReturnType<typeof setTimeout> | null;
  session: SttSession | null;
  /** Transcripts are handled in utterance order through this chain. */
  results: Promise<void>;
  /** Ended utterances whose transcript has not been handled yet. */
  inflight: number;
  /** Transcribed fragments held back in case the user is not finished. */
  pending: { text: string; firstAt: number; timer: ReturnType<typeof setTimeout> | null } | null;
  /** The current utterance began over a reply and has not cut it off (yet). */
  overPlayback: boolean;
  /** Voiced speech in the current overlapping utterance, after confirmation. */
  overlapVoicedMs: number;
}

export class VoicePipeline {
  private readonly stt: SpeechToText;
  private readonly tts: TextToSpeech;
  private readonly player: AudioPlayer;
  private readonly playback: Playback;
  private readonly backchannel: VoicePipelineConfig["backchannel"];
  private readonly endSilenceMs: number | undefined;
  private readonly mergeMs: number;
  private readonly bargeInMs: number;
  /** Users whose speech currently has the reply ducked. */
  private readonly duckers = new Set<string>();
  private rateLimitLoggedAt = 0;

  private connection: VoiceConnection | null = null;
  private channelId: string | null = null;
  private guildId: string | null = null;
  private readonly listeners = new Map<string, Listener>();
  private readonly sttRequestTimes = new Map<string, number[]>();
  /** Set on barge-in: replies still in flight belong to the cut-off turn and are dropped until the next transcript. */
  private dropRepliesUntilTranscript = false;

  private muted = false;
  private destroyed = false;
  private transcriptionCb: TranscriptionCallback | null = null;
  /** Set when the user cuts Claude off; delivered with their next transcript. */
  private interruptionNote: string | null = null;
  private backchannelTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly inactivityTimeoutMs: number;
  private inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  private usageLogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: Client, config: VoicePipelineConfig) {
    this.inactivityTimeoutMs = config.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
    this.backchannel = config.backchannel;
    this.endSilenceMs = config.endSilenceMs;
    this.mergeMs = config.mergeMs ?? DEFAULT_MERGE_MS;
    this.bargeInMs = config.bargeInMs ?? DEFAULT_BARGE_IN_MS;

    this.stt = new SpeechToText({
      apiKey: config.elevenLabsApiKey,
      model: config.sttModel,
      language: config.language,
      timeoutMs: config.sttTimeoutMs,
      keyterms: config.sttKeyterms,
      dailyBudgetSeconds: config.sttDailySeconds,
    });
    this.tts = new TextToSpeech({
      apiKey: config.elevenLabsApiKey,
      model: config.ttsModel,
      voice: config.voice,
      language: config.language,
      dailyBudgetChars: config.ttsDailyChars,
    });
    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.playback = new Playback(this.player, this.tts);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  onTranscription(cb: TranscriptionCallback): void {
    this.transcriptionCb = cb;
  }

  /** True while a reply is being spoken or queued. */
  get busy(): boolean {
    return this.playback.busy;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  get status(): {
    connected: boolean;
    channelId: string | null;
    activeUsers: string[];
    sttUsage: STTUsage;
    ttsUsage: BudgetSnapshot;
    ttsCache: { hits: number; misses: number };
  } {
    const { hits, misses } = this.tts.cacheStats;
    return {
      connected: this.connection !== null && !this.destroyed,
      channelId: this.channelId,
      activeUsers: [...this.listeners.keys()],
      sttUsage: this.stt.usage,
      ttsUsage: this.tts.usage,
      ttsCache: { hits, misses },
    };
  }

  async join(channel: VoiceChannel | StageChannel): Promise<void> {
    if (this.destroyed) throw new Error("Pipeline has been destroyed");
    if (this.connection) this.leave();

    this.channelId = channel.id;
    this.guildId = channel.guild.id;
    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false, // must not be deaf to receive audio
      selfMute: false,
      debug: process.env.VOICE_DEBUG === "1",
    });

    try {
      await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      this.connection.destroy();
      this.connection = null;
      this.channelId = null;
      this.guildId = null;
      throw new Error("Failed to join voice channel within 20 seconds");
    }

    this.connection.subscribe(this.player);
    this.playSilence();
    this.tts.warmUp();

    this.connection.receiver.speaking.on("start", (userId: string) => {
      if (this.destroyed || this.muted) return;
      if (!isAllowedSpeaker(userId)) {
        // Not on the allowlist: never subscribe, decode or transcribe. Also drop
        // a listener left over from before the user was removed.
        const existing = this.listeners.get(userId);
        if (existing) this.dropListener(existing);
        this.noteIgnored(userId);
        return;
      }
      if (this.listeners.has(userId)) return;
      this.subscribeToUser(userId).catch((err) => {
        console.error(`[voice-pipeline] error subscribing to user ${userId}: ${safeError(err)}`);
      });
    });

    this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      if (this.destroyed || !this.connection) return;
      try {
        await Promise.race([
          entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
        await entersState(this.connection, VoiceConnectionStatus.Ready, 10_000);
        this.connection.subscribe(this.player);
        this.playSilence();
        debugLog("RECONNECTED: player re-subscribed after disconnect");
      } catch {
        console.error("[voice-pipeline] disconnected and could not reconnect");
        this.leave();
      }
    });

    this.connection.on("error" as never, (err: Error) => {
      if (/DAVE|E2EE|encryption/.test(err.message ?? "")) {
        console.warn(
          "[voice-pipeline] DAVE E2EE error detected. Audio receive may not work in servers with " +
            "end-to-end encryption enabled. Consider using a Stage Channel, which does not enforce DAVE.",
        );
      } else {
        console.error(`[voice-pipeline] connection error: ${safeError(err)}`);
      }
    });

    this.resetInactivityTimer();
    this.startUsageLogging();
    console.error(`[voice-pipeline] joined channel ${channel.name} (${channel.id}) in guild ${channel.guild.name}`);
  }

  leave(): void {
    this.stopUsageLogging();
    this.clearInactivityTimer();
    this.cancelBackchannel();

    for (const listener of this.listeners.values()) this.dropListener(listener);
    this.playback.interrupt();
    this.interruptionNote = null;

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        // already destroyed
      }
      this.connection = null;
    }

    const previous = this.channelId;
    this.channelId = null;
    this.guildId = null;
    if (previous) console.error(`[voice-pipeline] left channel ${previous}`);
  }

  /**
   * Speak `text`. Calls queue up in order, so Claude can send a reply
   * sentence by sentence and the first one starts playing immediately.
   */
  async playResponse(text: string): Promise<void> {
    if (this.destroyed || !this.connection || this.muted) {
      debugLog(`PLAY_RESPONSE_SKIPPED: destroyed=${this.destroyed} connection=${!!this.connection} muted=${this.muted}`);
      return;
    }
    if (this.dropRepliesUntilTranscript) {
      debugLog("REPLY_DROPPED: reply arrived after the user cut in; waiting for their next words");
      return;
    }
    this.cancelBackchannel();
    this.playback.enqueue(text);
  }

  /** Stop speaking. Returns true if anything was being said or queued. */
  interrupt(): boolean {
    const wasBusy = this.playback.busy;
    if (wasBusy) this.interruptPlayback();
    return wasBusy;
  }

  setLanguage(language: string | undefined): void {
    this.stt.setLanguage(language);
    this.tts.setLanguage(language);
    console.error(`[voice-pipeline] language set to ${language ?? "auto"}`);
  }

  setVoice(voice: string): void {
    this.tts.setVoice(voice);
    console.error(`[voice-pipeline] voice set to ${voice}`);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (muted) {
      this.cancelBackchannel();
      this.playback.interrupt();
      for (const listener of this.listeners.values()) {
        listener.session?.cancel();
        listener.session = null;
      }
    }
    console.error(`[voice-pipeline] muted: ${muted}`);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.leave();
    this.tts.close();
    this.stt.dispose();
    this.transcriptionCb = null;
    console.error("[voice-pipeline] destroyed");
  }

  // -------------------------------------------------------------------------
  // Listening
  // -------------------------------------------------------------------------

  private async subscribeToUser(userId: string): Promise<void> {
    if (!isAllowedSpeaker(userId)) return;
    const member = this.resolveGuildMember(userId);
    if (member?.user?.bot || this.listeners.has(userId)) return;
    const receiver = this.connection?.receiver;
    if (!receiver) return;

    let stream: Readable;
    try {
      // Stay subscribed so pre-roll audio survives pauses and nothing is lost to resubscribing.
      stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } }) as unknown as Readable;
    } catch (err) {
      const msg = safeError(err);
      if (/DAVE|E2EE|encryption|decrypt/.test(msg)) {
        console.warn(`[voice-pipeline] cannot receive audio from user ${userId} -- likely DAVE E2EE. Try a Stage Channel.`);
      } else {
        console.error(`[voice-pipeline] failed to subscribe to user ${userId}: ${msg}`);
      }
      return;
    }

    const decoder = createOpusDecoder();
    const downsampler = createDownsampler();
    const speechBuffer = await SpeechBuffer.create({ silenceDuration: this.endSilenceMs });
    if (this.listeners.has(userId) || this.destroyed) {
      stream.destroy();
      return;
    }

    const listener: Listener = {
      userId,
      stream,
      decoder,
      downsampler,
      speechBuffer,
      chain: Promise.resolve(),
      idleTimer: null,
      session: null,
      results: Promise.resolve(),
      inflight: 0,
      pending: null,
      overPlayback: false,
      overlapVoicedMs: 0,
    };
    this.listeners.set(userId, listener);

    const onError = (source: string) => (err: Error) => {
      console.error(`[voice-pipeline] ${source} error for user ${userId}: ${safeError(err)}`);
      this.dropListener(listener);
    };
    stream.on("error", onError("audio stream"));
    decoder.on("error", onError("decoder"));
    downsampler.on("error", onError("downsampler"));
    stream.on("end", () => this.dropListener(listener));

    stream.pipe(decoder).pipe(downsampler);
    downsampler.on("data", (chunk: Buffer) => this.process(listener, () => listener.speechBuffer.feed(chunk)));

    console.error(`[voice-pipeline] subscribed to user ${member?.displayName ?? userId} (${userId})`);
  }

  /**
   * Run VAD work in order. Discord stops sending packets when a user goes
   * quiet, so a timer ends the utterance once no audio has arrived for the
   * silence window.
   */
  private process(listener: Listener, task: () => Promise<SpeechEvent[]> | SpeechEvent[]): void {
    listener.chain = listener.chain.then(async () => {
      try {
        for (const event of await task()) this.onSpeechEvent(listener, event);
        if (listener.idleTimer) clearTimeout(listener.idleTimer);
        listener.idleTimer = listener.speechBuffer.speaking
          ? setTimeout(() => this.process(listener, () => listener.speechBuffer.endOfInput()), listener.speechBuffer.endSilenceMs)
          : null;
      } catch (err) {
        console.error(`[voice-pipeline] audio handler error for user ${listener.userId}: ${safeError(err)}`);
        this.dropListener(listener);
      }
    });
  }

  private dropListener(listener: Listener): void {
    if (this.listeners.get(listener.userId) !== listener) return;
    this.listeners.delete(listener.userId);
    if (listener.idleTimer) clearTimeout(listener.idleTimer);
    listener.session?.cancel();
    listener.overPlayback = false;
    this.unduck(listener.userId);
    this.flushPending(listener); // what was already understood still counts
    this.sttRequestTimes.delete(listener.userId);
    try {
      listener.stream.destroy();
      listener.decoder.destroy();
      listener.downsampler.destroy();
    } catch {
      // streams may already be closed
    }
  }

  private onSpeechEvent(listener: Listener, event: SpeechEvent): void {
    if (this.destroyed || this.muted) return;

    switch (event.type) {
      case "start":
        this.onSpeechStart(listener, event.audio);
        break;
      case "audio":
        listener.session?.write(event.audio);
        if (listener.overPlayback && event.speech) {
          listener.overlapVoicedMs += VAD_FRAME_MS;
          if (listener.overlapVoicedMs >= this.bargeInMs) this.bargeIn(listener);
        }
        break;
      case "end":
        this.onSpeechEnd(listener, event.discard);
        break;
    }
  }

  private onSpeechStart(listener: Listener, audio: Buffer): void {
    this.resetInactivityTimer();
    this.cancelBackchannel();
    this.holdPending(listener);

    listener.overPlayback = false;
    listener.overlapVoicedMs = 0;
    if (this.playback.busy) {
      if (this.bargeInMs <= 0) {
        this.interruptPlayback();
      } else {
        // Maybe a real interruption, maybe just "mm": duck now, decide shortly.
        listener.overPlayback = true;
        this.duckers.add(listener.userId);
        this.playback.setDucked(true);
      }
    }
    this.tts.warmUp();

    if (this.withinRateLimit(listener.userId)) {
      listener.session = this.stt.open();
    } else {
      listener.session = null;
      if (Date.now() - this.rateLimitLoggedAt > 60_000) {
        this.rateLimitLoggedAt = Date.now();
        console.error(
          `[voice-pipeline] more than ${MAX_STT_REQUESTS_PER_MINUTE_PER_USER} utterances in a minute from ${listener.userId}; skipping transcription`,
        );
      }
    }
    listener.session?.write(audio);
  }

  /** The user kept talking over the reply: cut it off. */
  private bargeIn(listener: Listener): void {
    listener.overPlayback = false;
    if (this.playback.busy) this.interruptPlayback();
    this.unduck(listener.userId);
    debugLog(`BARGE_IN: after ${listener.overlapVoicedMs}ms of speech over the reply`);
  }

  private unduck(userId: string): void {
    if (this.duckers.delete(userId) && this.duckers.size === 0) this.playback.setDucked(false);
  }

  private onSpeechEnd(listener: Listener, discard: boolean): void {
    const { session, userId } = listener;
    listener.session = null;
    const overPlayback = listener.overPlayback;
    listener.overPlayback = false;

    let result: Promise<string>;
    if (!session) {
      if (!discard && this.stt.usage.exhausted) {
        console.error("[voice-pipeline] STT daily budget exhausted, not transcribing");
        this.emit(userId, "system", "[STT budget reached for today. Voice transcription paused until midnight.]");
      }
      result = Promise.resolve("");
    } else if (discard) {
      session.cancel();
      result = Promise.resolve("");
    } else {
      const endedAt = performance.now();
      this.playback.turnEndedAt = endedAt;
      result = session.commit().then(
        (text) => {
          timing(
            `STT_LATENCY: ${(performance.now() - endedAt).toFixed(0)}ms from end of speech to transcript (${session.durationMs.toFixed(0)}ms of audio)`,
          );
          return text;
        },
        (err) => {
          console.error(`[voice-pipeline] transcription failed: ${safeError(err)}`);
          if (err instanceof ElevenLabsError && err.quotaExceeded) {
            this.emit(userId, "system", "[ElevenLabs quota exceeded. Transcription is unavailable until the quota resets or the plan is upgraded.]");
          }
          return "";
        },
      );
    }

    // Handle transcripts strictly in the order the user spoke.
    listener.inflight++;
    listener.results = listener.results
      .then(() => result)
      .then((text) => {
        listener.inflight--;
        this.onUtterance(listener, text, overPlayback);
      })
      .catch((err) => console.error(`[voice-pipeline] transcript handling failed: ${safeError(err)}`));
  }

  /** One utterance's transcript (empty when nothing usable was said). */
  private onUtterance(listener: Listener, text: string, overPlayback: boolean): void {
    if (this.destroyed) return;
    if (overPlayback) {
      // Spoken over a reply but too short to cut it off on length alone.
      this.unduck(listener.userId);
      const kind = text ? classifyOverlap(text) : "filler";
      debugLog(`OVERLAP: ${kind}`);
      if (kind === "filler") {
        this.reschedulePending(listener);
        return;
      }
      if (kind === "ack" && this.playback.busy) {
        text = `${OVERLAP_ACK_NOTE} ${text}`;
      } else if (this.playback.busy) {
        this.interruptPlayback(); // short but real: "stopp", "vent"
      }
    }
    if (text) {
      if (listener.pending) listener.pending.text = `${listener.pending.text} ${text}`;
      else listener.pending = { text, firstAt: Date.now(), timer: null };
    }
    this.reschedulePending(listener);
  }

  /** The user started talking again: keep held fragments until this utterance is transcribed. */
  private holdPending(listener: Listener): void {
    const pending = listener.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;
  }

  /** Deliver held fragments now, after a short wait, or later once the user stops talking. */
  private reschedulePending(listener: Listener): void {
    const pending = listener.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = null;

    if (Date.now() - pending.firstAt >= MAX_MERGE_MS) {
      this.flushPending(listener);
      return;
    }
    const stillTalking = listener.speechBuffer.speaking || listener.session !== null || listener.inflight > 0;
    if (stillTalking) return; // the next transcript reschedules
    if (looksComplete(pending.text)) {
      this.flushPending(listener);
      return;
    }
    pending.timer = setTimeout(() => this.flushPending(listener), this.mergeMs);
  }

  private flushPending(listener: Listener): void {
    const pending = listener.pending;
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    listener.pending = null;
    timing(`TURN_HELD: ${Date.now() - pending.firstAt}ms from first fragment to delivery`);
    this.deliver(listener.userId, pending.text);
  }

  private deliver(userId: string, text: string): void {
    const note = this.interruptionNote;
    this.interruptionNote = null;
    const username = this.usernameOf(userId);
    debugLog(`TRANSCRIPT: ${username} ${debugText("text", text)}`);
    this.emit(userId, username, note ? `${note}\n${text}` : text);
    this.scheduleBackchannel();
  }

  private readonly ignoredNoted = new Set<string>();

  /** Log once per user that audio from a non-allowed speaker is being ignored. */
  private noteIgnored(userId: string): void {
    if (this.ignoredNoted.has(userId)) return;
    this.ignoredNoted.add(userId);
    if (this.ignoredNoted.size > 1000) this.ignoredNoted.clear();
    const hint = loadAllowlist().ids.length === 0 ? ` ${allowlistHelp()}` : "";
    console.error(`[voice-pipeline] ignoring speaker ${userId}: not on the allowlist.${hint}`);
  }

  private emit(userId: string, username: string, text: string): void {
    this.dropRepliesUntilTranscript = false;
    this.transcriptionCb?.(userId, username, text, this.channelId ?? "unknown");
  }

  private withinRateLimit(userId: string): boolean {
    const now = Date.now();
    const times = (this.sttRequestTimes.get(userId) ?? []).filter((t) => t > now - 60_000);
    const allowed = times.length < MAX_STT_REQUESTS_PER_MINUTE_PER_USER;
    if (allowed) times.push(now);
    this.sttRequestTimes.set(userId, times);
    return allowed;
  }

  // -------------------------------------------------------------------------
  // Barge-in and filler
  // -------------------------------------------------------------------------

  private interruptPlayback(): void {
    this.dropRepliesUntilTranscript = true;
    const interrupted = this.playback.interrupt();
    if (interrupted) this.interruptionNote = describeInterruption(interrupted);
    debugLog(`INTERRUPT: ${interrupted ? `spoken ${interrupted.spokenChars}/${interrupted.text.length} chars` : "nothing audible"}`);
  }

  private scheduleBackchannel(): void {
    this.cancelBackchannel();
    if (!this.backchannel) return;
    const { text, delayMs } = this.backchannel;
    this.backchannelTimer = setTimeout(() => {
      this.backchannelTimer = null;
      if (!this.destroyed && !this.muted && this.connection && !this.playback.busy) this.playback.enqueue(text, true);
    }, delayMs);
  }

  private cancelBackchannel(): void {
    if (this.backchannelTimer) clearTimeout(this.backchannelTimer);
    this.backchannelTimer = null;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private resolveGuildMember(userId: string): GuildMember | undefined {
    if (!this.guildId) return undefined;
    return this.client.guilds.cache.get(this.guildId)?.members.cache.get(userId);
  }

  private usernameOf(userId: string): string {
    const member = this.resolveGuildMember(userId);
    return member?.displayName ?? member?.user?.username ?? userId;
  }

  /** Play a few silent Opus frames; Discord forwards other users' audio only after the bot transmits. */
  private playSilence(): void {
    try {
      const silence = new Readable({
        read() {
          for (let i = 0; i < 5; i++) this.push(SILENT_OPUS_FRAME);
          this.push(null);
        },
      });
      silence.on("error", (err: Error) => console.warn(`[voice-pipeline] silence stream error: ${err.message}`));
      this.player.play(createAudioResource(silence, { inputType: StreamType.Arbitrary }));
    } catch (err) {
      console.warn(`[voice-pipeline] failed to play silence: ${safeError(err)}`);
    }
  }

  private resetInactivityTimer(): void {
    this.clearInactivityTimer();
    this.inactivityTimer = setTimeout(() => {
      if (!this.channelId) return;
      console.error(`[voice-pipeline] no speech for ${Math.round(this.inactivityTimeoutMs / 1000)}s, disconnecting`);
      this.leave();
    }, this.inactivityTimeoutMs);
  }

  private clearInactivityTimer(): void {
    if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
    this.inactivityTimer = null;
  }

  private startUsageLogging(): void {
    this.stopUsageLogging();
    this.usageLogTimer = setInterval(() => {
      const stt = this.stt.usage;
      const tts = this.tts.usage;
      if (stt.transcriptions > 0 || tts.used > 0) {
        console.error(
          `[voice-pipeline] usage today: STT ${stt.used.toFixed(0)}s (${stt.transcriptions} transcripts), ` +
            `TTS ${tts.used} chars, cache ${this.tts.cacheStats.hits} hits / ${this.tts.cacheStats.misses} misses`,
        );
      }
    }, USAGE_LOG_INTERVAL_MS);
  }

  private stopUsageLogging(): void {
    if (this.usageLogTimer) clearInterval(this.usageLogTimer);
    this.usageLogTimer = null;
  }
}
