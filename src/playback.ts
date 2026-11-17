/**
 * Plays queued spoken replies through a Discord audio player.
 *
 * The next reply is synthesized while the current one plays, so consecutive
 * replies join without a gap. interrupt() cancels everything in flight and
 * fades the current audio out over a few milliseconds instead of cutting it.
 */

import { safeError } from "./redact.js";
import { AudioPlayerStatus, createAudioResource, StreamType, type AudioPlayer, type AudioResource } from "@discordjs/voice";
import { debugLog, timing } from "./debug.js";
import { isTtsAbort, type SpeechStream, type TextToSpeech } from "./tts.js";

const FADE_STEPS = 3;
const FADE_STEP_MS = 4;
/** Volume while the user may be cutting in, before it is clear they really are. */
const DUCK_VOLUME = 0.3;

interface Reply {
  text: string;
  /** Short filler such as "mm"; never reported as an interrupted reply. */
  filler: boolean;
  speech?: SpeechStream;
}

interface Playing {
  reply: Reply;
  speech: SpeechStream;
  resource: AudioResource;
}

export interface InterruptedReply {
  text: string;
  spokenChars: number;
}

export class Playback {
  private readonly queue: Reply[] = [];
  private current: Playing | null = null;
  private ducked = false;
  /** performance.now() of the user's last end of speech, for latency logging. */
  turnEndedAt = 0;

  constructor(
    private readonly player: AudioPlayer,
    private readonly tts: TextToSpeech,
  ) {
    player.on(AudioPlayerStatus.Idle, () => this.advance());
    player.on("error", (err) => {
      console.error(`[playback] audio player error: ${safeError(err)}`);
      this.advance();
    });
  }

  get busy(): boolean {
    return this.current !== null || this.queue.length > 0;
  }

  enqueue(text: string, filler = false): void {
    this.queue.push({ text, filler });
    this.prefetch();
    if (!this.current) this.playNext();
  }

  /** Lower the volume while the user might be cutting in; restore it when they were not. */
  setDucked(ducked: boolean): void {
    if (ducked === this.ducked) return;
    this.ducked = ducked;
    this.current?.resource.volume?.setVolume(ducked ? DUCK_VOLUME : 1);
  }

  /**
   * Stop speaking now. Returns what was being said, or null when nothing was
   * playing or only a filler was.
   */
  interrupt(): InterruptedReply | null {
    const playing = this.current;
    const interrupted =
      playing && !playing.reply.filler
        ? { text: playing.reply.text, spokenChars: playing.speech.spokenChars() }
        : null;

    this.queue.length = 0;
    this.current = null;
    this.tts.abort();
    if (playing) this.fadeOutAndStop(playing.resource);
    return interrupted;
  }

  private advance(): void {
    if (!this.current) return; // idle caused by interrupt() or the join silence
    this.current = null;
    this.playNext();
    if (!this.current) this.tts.warmUp();
  }

  private prefetch(): void {
    const next = this.queue[0];
    if (next) next.speech ??= this.tts.speak(next.text);
  }

  private playNext(): void {
    const reply = this.queue.shift();
    if (!reply) return;
    const speech = reply.speech ?? this.tts.speak(reply.text);
    this.prefetch();

    speech.done.catch((err) => {
      if (!isTtsAbort(err)) console.error(`[playback] speech synthesis failed: ${safeError(err)}`);
    });

    const resource = createAudioResource(speech, { inputType: StreamType.Raw, inlineVolume: true });
    if (this.ducked) resource.volume?.setVolume(DUCK_VOLUME);
    this.current = { reply, speech, resource };
    this.player.play(resource);

    const logLatency = () => {
      if (this.turnEndedAt > 0 && !reply.filler) {
        timing(`TURN_LATENCY: ${(performance.now() - this.turnEndedAt).toFixed(0)}ms from end of speech to first audio`);
        this.turnEndedAt = 0;
      }
    };
    if (speech.hasAudio) logLatency();
    else speech.once("firstAudio", logLatency);
  }

  private fadeOutAndStop(resource: AudioResource): void {
    let step = 0;
    const start = resource.volume?.volume ?? 1;
    const timer = setInterval(() => {
      step++;
      resource.volume?.setVolume(start * (1 - step / FADE_STEPS));
      if (step < FADE_STEPS) return;
      clearInterval(timer);
      // A newer reply may already own the player; only stop our own audio.
      if (this.player.state.status !== AudioPlayerStatus.Idle && this.player.state.resource === resource) {
        this.player.stop(true);
      }
    }, FADE_STEP_MS);
  }
}

/**
 * Tell Claude that its reply was cut off. Deliberately short and does not quote the
 * unheard rest of the reply: quoting it made the model pick up the sentence again.
 */
export function describeInterruption(_interrupted: InterruptedReply): string {
  return "[The user interrupted you and your reply stopped. Do not finish or repeat the old answer. Listen to what they say next and answer that, in one short sentence.]";
}
