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
      return ["-f", "dshow", "-i", `audio=${device}`];
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

export function startMic(device: string, onChunk: (pcm: Buffer) => void, onError: (msg: string) => void): Mic {
  const child: ChildProcess = spawn(
    ffmpegBinary(),
    ["-hide_banner", "-loglevel", "error", ...micInputArgs(device), "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
    { windowsHide: true },
  );
  child.stdout!.on("data", (d: Buffer) => onChunk(d));
  child.stderr!.on("data", (d: Buffer) => onError(d.toString().trim()));
  child.on("error", (err) => onError(`could not start ffmpeg: ${err.message}`));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      const hint = process.platform === "darwin" ? " On macOS, allow microphone access for your terminal in System Settings > Privacy & Security > Microphone." : "";
      onError(`microphone capture stopped (exit ${code}).${hint}`);
    }
  });
  return { stop: () => child.kill() };
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
