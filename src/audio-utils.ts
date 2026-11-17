import { Transform, TransformCallback } from "stream";
import OpusScript from "opusscript";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { createRequire } from "module";

const DEFAULT_SILENCE_DURATION_MS = 300; // reduced from 450 — faster utterance emission
const DEFAULT_MIN_SPEECH_DURATION_MS = 200; // catch short "ja"/"nei" (~200ms)
const DEFAULT_MAX_SPEECH_DURATION_MS = 30000; // prevents runaway noise accumulation
const DEFAULT_PRE_ROLL_MS = 300;
const DEFAULT_CONFIRM_MS = 160; // ~5 VAD frames of continuous speech before an utterance starts
const MIN_SPEECH_RATIO = 0.2; // below this share of speech frames an utterance is treated as noise
const RMS_FALLBACK_THRESHOLD = 700;
const DIGITAL_SILENCE_RMS = 20; // Lowered from 50 — avoid filtering quiet speakers

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_CHANNELS = 2;
const STT_SAMPLE_RATE = 16000;
const BYTES_PER_SAMPLE = 2; // 16-bit audio

// Silero VAD v5 uses 512 samples per frame at 16kHz (32ms).
// At 16kHz mono 16-bit: 512 samples = 1024 bytes.
const VAD_FRAME_SAMPLES = 512;
const VAD_FRAME_BYTES = VAD_FRAME_SAMPLES * BYTES_PER_SAMPLE; // 1024
export const VAD_FRAME_MS = (VAD_FRAME_SAMPLES / STT_SAMPLE_RATE) * 1000; // 32

// Speech probability threshold — Silero v5 default is 0.5
const DEFAULT_SPEECH_THRESHOLD = 0.5;

// Opus packet validation constants
const OPUS_MIN_PACKET_SIZE = 1; // 1 byte = valid silence/DTX packet
const OPUS_MAX_PACKET_SIZE = 5760; // max Opus frame size in bytes

/**
 * Opus decoder using opusscript (pure JS/WASM) instead of the native
 * @discordjs/opus C binding.
 *
 * Why: @discordjs/opus 0.9.0 crashes with SIGSEGV on Node.js v24 (ABI v137)
 * when decoding real Discord audio packets. The native prebuild for
 * darwin-arm64 has a memory corruption bug that cannot be caught by
 * try-catch or uncaughtException handlers. opusscript uses Emscripten/WASM
 * which is immune to SIGSEGV — decode errors throw normal JS exceptions.
 *
 * Performance: opusscript is ~2-5x slower than native, but Opus decoding
 * is not the bottleneck (the network round trips are). At typical voice
 * rates (50 packets/sec), the CPU cost is negligible.
 */
class SafeOpusDecoder extends Transform {
  private decoder: InstanceType<typeof OpusScript>;
  private droppedPackets = 0;
  private decoderErrors = 0;

  constructor() {
    super();
    this.decoder = new OpusScript(
      DISCORD_SAMPLE_RATE,
      DISCORD_CHANNELS,
      OpusScript.Application.AUDIO,
    );
  }

  _transform(chunk: Buffer, _encoding: string, callback: TransformCallback): void {
    if (!chunk || chunk.length < OPUS_MIN_PACKET_SIZE || chunk.length > OPUS_MAX_PACKET_SIZE) {
      this.droppedPackets++;
      if (this.droppedPackets <= 5 || this.droppedPackets % 100 === 0) {
        console.error(
          `[opus-decoder] dropped invalid packet ` +
            `(${chunk?.length ?? 0} bytes, total dropped: ${this.droppedPackets})`,
        );
      }
      callback();
      return;
    }

    try {
      const pcm = this.decoder.decode(chunk);
      // opusscript returns a Buffer with interleaved 16-bit PCM samples
      this.push(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      callback();
    } catch (err) {
      this.decoderErrors++;
      if (this.decoderErrors <= 10 || this.decoderErrors % 100 === 0) {
        console.error(
          `[opus-decoder] decode error #${this.decoderErrors}: ` +
            `${err instanceof Error ? err.message : err}`,
        );
      }
      // Skip the packet and continue — don't crash the pipeline
      callback();
    }
  }

  _flush(callback: TransformCallback): void {
    callback();
  }

  _destroy(err: Error | null, callback: (error: Error | null) => void): void {
    try {
      this.decoder.delete();
    } catch {
      // Already deleted
    }
    callback(err);
  }
}

export function createOpusDecoder(): Transform {
  return new SafeOpusDecoder();
}

/** Windowed-sinc (Blackman) low-pass FIR with unity DC gain. `cutoff` is a fraction of the sample rate. */
export function designLowpass(taps: number, cutoff: number): Float64Array {
  const h = new Float64Array(taps);
  const m = taps - 1;
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - m / 2;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / m) + 0.08 * Math.cos((4 * Math.PI * n) / m);
    h[n] = sinc * window;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}

// 95 taps, 7 kHz cutoff at 48 kHz: flat speech band, strong rejection above
// the 8 kHz Nyquist limit of the 16 kHz output. About 1 ms of delay.
const DOWNSAMPLE_FIR = designLowpass(95, 7000 / DISCORD_SAMPLE_RATE);

/**
 * Downsample 48 kHz stereo to 16 kHz mono through a proper anti-aliasing
 * low-pass filter, computing only every third output sample.
 *
 * The earlier 3-sample box filter let most of the 8-16 kHz band (sibilants,
 * keyboard clicks, noise) fold back into the speech band, which hurt
 * transcription.
 */
export function createDownsampler(): Transform {
  const ratio = DISCORD_SAMPLE_RATE / STT_SAMPLE_RATE; // 3
  const inputFrameBytes = DISCORD_CHANNELS * BYTES_PER_SAMPLE; // 4 bytes per stereo sample
  const fir = DOWNSAMPLE_FIR;
  const historyLength = fir.length - 1;
  let history = new Float64Array(historyLength); // last mono samples of the previous chunk
  let next = historyLength; // index (in history + chunk) of the next output sample
  let residual = Buffer.alloc(0);

  return new Transform({
    transform(chunk: Buffer, _encoding: string, callback: TransformCallback) {
      const input = residual.length > 0 ? Buffer.concat([residual, chunk]) : chunk;
      const frames = Math.floor(input.length / inputFrameBytes);
      residual = Buffer.from(input.subarray(frames * inputFrameBytes));

      const mono = new Float64Array(historyLength + frames);
      mono.set(history);
      for (let i = 0; i < frames; i++) {
        const offset = i * inputFrameBytes;
        mono[historyLength + i] = (input.readInt16LE(offset) + input.readInt16LE(offset + BYTES_PER_SAMPLE)) / 2;
      }

      const outputSamples = next < mono.length ? Math.ceil((mono.length - next) / ratio) : 0;
      const output = Buffer.alloc(outputSamples * BYTES_PER_SAMPLE);
      for (let k = 0; k < outputSamples; k++, next += ratio) {
        let acc = 0;
        for (let j = 0; j < fir.length; j++) acc += fir[j] * mono[next - j];
        output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc))), k * BYTES_PER_SAMPLE);
      }

      history = mono.slice(mono.length - historyLength);
      next -= frames;
      if (output.length === 0) {
        callback();
        return;
      }
      callback(null, output);
    },

    flush(callback: TransformCallback) {
      residual = Buffer.alloc(0);
      callback();
    },
  });
}

export function calculateRMS(pcm: Buffer): number {
  const sampleCount = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (sampleCount === 0) return 0;

  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE);
    sumSquares += sample * sample;
  }

  return Math.sqrt(sumSquares / sampleCount);
}

interface SpeechBufferOptions {
  silenceDuration?: number;
  minSpeechDuration?: number;
  maxSpeechDuration?: number;
  /** Audio kept from before speech was confirmed, so the first word is never clipped. */
  preRoll?: number;
  /** Continuous speech required before an utterance starts. Filters coughs and clicks. */
  confirmDuration?: number;
  /** Silero VAD speech probability threshold (0-1). Default: 0.5. */
  speechThreshold?: number;
}

/** Events a SpeechBuffer emits while a user talks. All audio is 16 kHz mono 16-bit PCM. */
export type SpeechEvent =
  | { type: "start"; audio: Buffer } // speech confirmed; audio includes the pre-roll
  | { type: "audio"; audio: Buffer; speech: boolean } // speech: this frame was classified as voiced
  | { type: "end"; discard: boolean }; // discard: too short or mostly noise

const enum State {
  WAITING,
  CONFIRMING,
  SPEAKING,
}

/**
 * Silero VAD v5 model wrapper.
 * Loads the ONNX model from avr-vad's bundled files and exposes a simple
 * `process(frame)` method that returns speech probability.
 *
 * Silero v5 is dramatically more accurate than WebRTC VAD:
 *   - 87.7% TPR at 5% FPR (4x fewer errors than WebRTC VAD)
 *   - Trained on 6000+ languages
 *   - DNN-based vs WebRTC's GMM — better at speech vs noise separation
 */
interface SileroModel {
  process(frame: Float32Array): Promise<{ isSpeech: number; notSpeech: number }>;
  reset_state(): void;
}

interface SharedSilero {
  // Immutable ONNX session (weights) shared by every listener.
  create(): SileroModel;
}

let _shared: Promise<SharedSilero> | null = null;

/**
 * Load the ONNX session once and hand out a fresh SileroV5 wrapper per
 * listener. The recurrent state lives in the wrapper, so speakers never
 * influence each other's speech detection.
 */
function loadSileroV5(): Promise<SharedSilero> {
  if (_shared) return _shared;
  _shared = (async () => {
    const require_ = createRequire(import.meta.url);
    const ort = require_("onnxruntime-node");
    const { SileroV5 } = require_("avr-vad/dist/common/models");

    const avrVadPath = dirname(require_.resolve("avr-vad/package.json"));
    const modelPath = resolve(avrVadPath, "dist", "silero_vad_v5.onnx");
    const buf = readFileSync(modelPath);
    const modelBytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

    // Build one model to obtain the shared session and sample-rate tensor.
    const first = await SileroV5.new(ort, async () => modelBytes);
    const session = first._session;
    const sr = first._sr;
    const freshState = () => new ort.Tensor("float32", Array(2 * 128).fill(0), [2, 1, 128]);
    console.error("[speech-buffer] Silero VAD v5 loaded (ONNX, 16kHz, 512-sample frames)");

    let handedFirst = false;
    return {
      create(): SileroModel {
        if (!handedFirst) {
          handedFirst = true;
          return first as SileroModel;
        }
        return new SileroV5(session, freshState(), sr, ort) as SileroModel;
      },
    };
  })().catch((err) => {
    _shared = null; // allow a retry on the next listener
    throw err;
  });
  return _shared;
}

/**
 * Convert Int16 PCM buffer to Float32Array normalized to [-1, 1].
 * Silero VAD expects Float32 input.
 */
function pcmInt16ToFloat32(pcm: Buffer): Float32Array {
  const sampleCount = pcm.length / BYTES_PER_SAMPLE;
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
  }
  return float32;
}

/**
 * Streaming speech segmenter on top of Silero VAD v5.
 *
 * Emits `start` once speech has lasted `confirmDuration` (with `preRoll` of
 * earlier audio attached), then every VAD frame as `audio`, and finally `end`
 * after adaptive trailing silence. Use SpeechBuffer.create(); loading the
 * ONNX model is async.
 */
export class SpeechBuffer {
  private readonly silenceDurationMs: number;
  private readonly minSpeechDurationMs: number;
  private readonly maxSpeechDurationMs: number;
  private readonly preRollLimitMs: number;
  private readonly confirmFrames: number;
  private readonly speechThreshold: number;
  private readonly vad: SileroModel;

  // Silero v5 needs exactly 512 samples (32ms at 16kHz) per call.
  private frameAccumulator: Buffer = Buffer.alloc(0);

  private state: State = State.WAITING;
  private preRoll: Buffer[] = [];
  private preRollBufferedMs = 0;
  private candidate: Buffer[] = [];
  private totalAudioMs = 0;
  private speechStartMs = 0;
  private lastSpeechMs = 0;
  private speechFrames = 0;
  private totalFrames = 0;
  private feedCount = 0;

  private constructor(vad: SileroModel, options: SpeechBufferOptions) {
    this.silenceDurationMs = options.silenceDuration ?? DEFAULT_SILENCE_DURATION_MS;
    this.minSpeechDurationMs = options.minSpeechDuration ?? DEFAULT_MIN_SPEECH_DURATION_MS;
    this.maxSpeechDurationMs = options.maxSpeechDuration ?? DEFAULT_MAX_SPEECH_DURATION_MS;
    this.preRollLimitMs = options.preRoll ?? DEFAULT_PRE_ROLL_MS;
    this.confirmFrames = Math.ceil((options.confirmDuration ?? DEFAULT_CONFIRM_MS) / VAD_FRAME_MS);
    this.speechThreshold = options.speechThreshold ?? DEFAULT_SPEECH_THRESHOLD;
    this.vad = vad;
  }

  static async create(options: SpeechBufferOptions = {}): Promise<SpeechBuffer> {
    return new SpeechBuffer((await loadSileroV5()).create(), options);
  }

  /** True while an utterance is in progress (confirmed speech, not yet ended). */
  get speaking(): boolean {
    return this.state === State.SPEAKING;
  }

  /** How long to wait for more audio before treating silence as the end of the utterance. */
  get endSilenceMs(): number {
    const spokenMs = this.totalAudioMs - this.speechStartMs;
    if (spokenMs < 1000) return this.silenceDurationMs; // short answers: "yes", "no"
    if (spokenMs < 3000) return Math.max(this.silenceDurationMs, 400);
    return Math.max(this.silenceDurationMs, 500); // long sentences: allow thinking pauses
  }

  async feed(chunk: Buffer): Promise<SpeechEvent[]> {
    if (chunk.length === 0) return [];
    this.totalAudioMs += this.pcmToMs(chunk.length);
    this.feedCount++;

    // Digital silence while idle is codec padding; skip the VAD to save CPU.
    if (this.state === State.WAITING && calculateRMS(chunk) < DIGITAL_SILENCE_RMS) return [];

    this.frameAccumulator = Buffer.concat([this.frameAccumulator, chunk]);
    // Guard against unbounded growth if the stream is corrupt.
    if (this.frameAccumulator.length > VAD_FRAME_BYTES * 10) this.frameAccumulator = Buffer.alloc(0);

    const events: SpeechEvent[] = [];
    while (this.frameAccumulator.length >= VAD_FRAME_BYTES) {
      const frame = Buffer.from(this.frameAccumulator.subarray(0, VAD_FRAME_BYTES));
      this.frameAccumulator = this.frameAccumulator.subarray(VAD_FRAME_BYTES);
      events.push(...(await this.processFrame(frame)));
    }
    return events;
  }

  /** The audio source went quiet. Ends the current utterance, if any. */
  endOfInput(): SpeechEvent[] {
    const events: SpeechEvent[] = this.state === State.SPEAKING ? [this.endUtterance()] : [];
    this.state = State.WAITING;
    this.candidate = [];
    this.frameAccumulator = Buffer.alloc(0);
    this.resetVad();
    return events;
  }

  private async processFrame(frame: Buffer): Promise<SpeechEvent[]> {
    const isSpeech = await this.classify(frame);

    switch (this.state) {
      case State.WAITING:
        if (!isSpeech) {
          this.pushPreRoll(frame);
          return [];
        }
        this.state = State.CONFIRMING;
        this.candidate = [frame];
        return this.candidate.length >= this.confirmFrames ? this.startUtterance() : [];

      case State.CONFIRMING:
        if (!isSpeech) {
          for (const kept of [...this.candidate, frame]) this.pushPreRoll(kept);
          this.candidate = [];
          this.state = State.WAITING;
          return [];
        }
        this.candidate.push(frame);
        return this.candidate.length >= this.confirmFrames ? this.startUtterance() : [];

      case State.SPEAKING: {
        this.totalFrames++;
        if (isSpeech) {
          this.speechFrames++;
          this.lastSpeechMs = this.totalAudioMs;
        }
        const events: SpeechEvent[] = [{ type: "audio", audio: frame, speech: isSpeech }];
        const tooLong = this.totalAudioMs - this.speechStartMs >= this.maxSpeechDurationMs;
        const silentLongEnough = !isSpeech && this.totalAudioMs - this.lastSpeechMs >= this.endSilenceMs;
        if (tooLong || silentLongEnough) events.push(this.endUtterance());
        return events;
      }
    }
  }

  private startUtterance(): SpeechEvent[] {
    const audio = Buffer.concat([...this.preRoll, ...this.candidate]);
    this.speechStartMs = this.totalAudioMs - this.pcmToMs(Buffer.concat(this.candidate).length);
    this.lastSpeechMs = this.totalAudioMs;
    this.speechFrames = this.candidate.length;
    this.totalFrames = this.candidate.length;
    this.preRoll = [];
    this.preRollBufferedMs = 0;
    this.candidate = [];
    this.state = State.SPEAKING;
    return [{ type: "start", audio }];
  }

  private endUtterance(): SpeechEvent {
    const durationMs = this.totalAudioMs - this.speechStartMs;
    const speechRatio = this.totalFrames > 0 ? this.speechFrames / this.totalFrames : 0;
    this.state = State.WAITING;
    this.resetVad();
    // Short blips and mostly-noise segments would only produce hallucinated text.
    return { type: "end", discard: durationMs < this.minSpeechDurationMs || speechRatio < MIN_SPEECH_RATIO };
  }

  /** Clear the recurrent state so one utterance never leaks into the next. */
  private resetVad(): void {
    try {
      this.vad.reset_state();
    } catch {
      // state reset is best-effort
    }
  }

  private async classify(frame: Buffer): Promise<boolean> {
    try {
      const probs = await this.vad.process(pcmInt16ToFloat32(frame));
      return probs.isSpeech >= this.speechThreshold;
    } catch (err) {
      // Degrade to an energy threshold rather than dropping the user's speech.
      if (this.feedCount <= 5 || this.feedCount % 500 === 0) {
        console.error(`[speech-buffer] Silero VAD error, using RMS fallback: ${err instanceof Error ? err.message : err}`);
      }
      return calculateRMS(frame) >= RMS_FALLBACK_THRESHOLD;
    }
  }

  private pushPreRoll(frame: Buffer): void {
    this.preRoll.push(frame);
    this.preRollBufferedMs += this.pcmToMs(frame.length);
    while (this.preRollBufferedMs > this.preRollLimitMs && this.preRoll.length > 1) {
      this.preRollBufferedMs -= this.pcmToMs(this.preRoll.shift()!.length);
    }
  }

  private pcmToMs(byteLength: number): number {
    return (byteLength / BYTES_PER_SAMPLE / STT_SAMPLE_RATE) * 1000;
  }
}

/**
 * Upsample 24 kHz mono 16-bit PCM to 48 kHz stereo (Discord's raw format)
 * with linear interpolation. Stateful across chunks, tolerates odd chunk sizes.
 */
export class PcmUpsampler {
  private carry: Buffer = Buffer.alloc(0);
  private previous = 0;

  process(input: Buffer): Buffer {
    const data = this.carry.length > 0 ? Buffer.concat([this.carry, input]) : input;
    const samples = data.length >> 1;
    this.carry = Buffer.from(data.subarray(samples * 2));

    const output = Buffer.allocUnsafe(samples * 8); // 2 stereo frames per input sample
    let offset = 0;
    for (let i = 0; i < samples; i++) {
      const sample = data.readInt16LE(i * 2);
      const midpoint = (this.previous + sample) >> 1;
      offset = output.writeInt16LE(midpoint, offset);
      offset = output.writeInt16LE(midpoint, offset);
      offset = output.writeInt16LE(sample, offset);
      offset = output.writeInt16LE(sample, offset);
      this.previous = sample;
    }
    return output;
  }
}
