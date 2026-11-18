import { spawn, type ChildProcess } from "child_process";
import ffmpegStatic from "ffmpeg-static";

/**
 * Capture 16 kHz mono PCM16 from a microphone through ffmpeg.
 * Windows uses DirectShow (device name), macOS uses AVFoundation (device name, index or "default").
 */
export interface Mic {
  stop(): void;
}

/** The ffmpeg binary: JARVIS_FFMPEG if set, else the bundled ffmpeg-static, else ffmpeg on PATH. */
export function ffmpegBinary(env: NodeJS.ProcessEnv = process.env): string {
  return env.JARVIS_FFMPEG?.trim() || ffmpegStatic || "ffmpeg";
}

/** ffmpeg input arguments for one microphone on this platform. */
export function micInputArgs(device: string, platform: NodeJS.Platform = process.platform): string[] {
  switch (platform) {
    case "win32":
      // DirectShow buffers 500 ms by default; 50 ms chunks let the voice detector react that much sooner.
      return ["-f", "dshow", "-audio_buffer_size", "50", "-i", `audio=${device}`];
    case "darwin":
      // AVFoundation takes "video:audio"; an empty video part means audio only.
      return ["-f", "avfoundation", "-i", `:${device || "default"}`];
    default:
      throw new Error(`Microphone capture is not supported on ${platform} yet (Windows and macOS are).`);
  }
}

/** ffmpeg arguments that print the audio devices on this platform. */
export function listDeviceArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin"
    ? ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]
    : ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"];
}

/** Pull audio device names out of ffmpeg's device listing (it prints to stderr). */
export function parseDeviceList(output: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== "darwin") return [...output.matchAll(/"([^"]+)"\s+\(audio\)/g)].map((m) => m[1]);
  // macOS: "[AVFoundation indev @ 0x...] [0] MacBook Pro Microphone", after the "audio devices:" header.
  const names: string[] = [];
  let audio = false;
  for (const line of output.split(/\r?\n/)) {
    if (/AVFoundation audio devices:/i.test(line)) audio = true;
    else if (/AVFoundation video devices:/i.test(line)) audio = false;
    else if (audio) {
      const m = line.match(/\]\s*\[(\d+)\]\s+(.+?)\s*$/);
      if (m) names.push(m[2]);
    }
  }
  return names;
}

/** Largest absolute sample in a PCM16 chunk. Real microphones never stay below a few units; muted or stale devices send exact zeros. */
export function peakLevel(pcm: Buffer): number {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const s = Math.abs(pcm.readInt16LE(i));
    if (s > peak) peak = s;
  }
  return peak;
}

export interface MicOptions {
  /** Restart capture when no audio arrives for this long (a stalled device). Default 3 s. */
  stallMs?: number;
  /** Restart capture after this much unbroken digital silence (a muted, sleeping or reconnected headset). Default 20 s. */
  silenceMs?: number;
  /** Longest wait between restart attempts while the device is missing. Default 10 s. */
  maxBackoffMs?: number;
  /** For tests. */
  spawnFn?: (cmd: string, args: string[]) => ChildProcess;
}

const DIGITAL_SILENCE_PEAK = 4;

/**
 * Capture the microphone and keep it alive. The headset can be muted, go to sleep, be switched off
 * or reconnected, and ffmpeg then stalls, exits, or keeps a stale handle that only delivers zeros.
 * Each case restarts capture (with backoff while the device is missing), so the assistant starts
 * hearing again by itself instead of needing a restart.
 */
export function startMic(device: string, onChunk: (pcm: Buffer) => void, onLog: (msg: string) => void, opts: MicOptions = {}): Mic {
  const stallMs = opts.stallMs ?? 3_000;
  const silenceMs = opts.silenceMs ?? 20_000;
  const maxBackoffMs = opts.maxBackoffMs ?? 10_000;
  const spawnFn = opts.spawnFn ?? ((cmd, args) => spawn(cmd, args, { windowsHide: true }));
  const args = ["-hide_banner", "-loglevel", "error", ...micInputArgs(device), "-ac", "1", "-ar", "16000", "-flush_packets", "1", "-f", "s16le", "-"];

  let child: ChildProcess | null = null;
  let stopped = false;
  let lastData = Date.now();
  let silentSince: number | null = null;
  let warnedSilence = false;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  const start = () => {
    restartTimer = null;
    if (stopped) return;
    lastData = Date.now();
    const proc = spawnFn(ffmpegBinary(), args);
    child = proc;
    proc.stdout!.on("data", (d: Buffer) => {
      if (child !== proc) return;
      lastData = Date.now();
      if (failures > 0) {
        onLog("microphone is back");
        failures = 0;
      }
      if (peakLevel(d) <= DIGITAL_SILENCE_PEAK) {
        silentSince ??= Date.now();
      } else {
        if (warnedSilence) onLog("microphone hears sound again");
        silentSince = null;
        warnedSilence = false;
      }
      onChunk(d);
    });
    proc.stderr!.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg && failures < 2) onLog(msg);
    });
    proc.on("error", (err) => onLog(`could not start ffmpeg: ${err.message}`));
    proc.on("exit", (code) => {
      if (child !== proc || stopped) return;
      child = null;
      failures++;
      const wait = Math.min(maxBackoffMs, 500 * 2 ** Math.min(failures - 1, 5));
      if (failures === 1) {
        const hint = process.platform === "darwin" ? " On macOS, allow microphone access for your terminal in System Settings > Privacy & Security > Microphone." : "";
        onLog(`microphone capture stopped (exit ${code ?? "signal"}); retrying until it is back.${hint}`);
      }
      restartTimer = setTimeout(start, wait);
    });
  };

  const restart = (why: string) => {
    if (stopped || !child) return;
    onLog(`restarting microphone capture: ${why}`);
    const old = child;
    child = null;
    old.kill();
    silentSince = null;
    restartTimer = setTimeout(start, 300);
  };

  const watchdog = setInterval(() => {
    if (stopped || !child) return;
    const now = Date.now();
    if (now - lastData > stallMs) restart(`no audio for ${Math.round((now - lastData) / 1000)} s`);
    else if (silentSince !== null && now - silentSince > silenceMs) {
      if (!warnedSilence) onLog("microphone sends pure silence: is the headset muted, asleep or switched off?");
      warnedSilence = true;
      restart("only silence");
    }
  }, Math.min(1_000, stallMs / 2, silenceMs / 2));
  watchdog.unref?.();

  start();
  return {
    stop: () => {
      stopped = true;
      clearInterval(watchdog);
      if (restartTimer) clearTimeout(restartTimer);
      child?.kill();
      child = null;
    },
  };
}

/** Lists audio input devices, for finding the JARVIS_MIC value. */
export function listMicDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegBinary(), listDeviceArgs(), { windowsHide: true });
    let out = "";
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve([]));
    child.on("close", () => resolve(parseDeviceList(out)));
  });
}
