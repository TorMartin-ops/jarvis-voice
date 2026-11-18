import { spawn, type ChildProcess } from "child_process";
import ffmpegPath from "ffmpeg-static";

/** Capture 16 kHz mono PCM16 from a Windows microphone (DirectShow device name). */
export interface Mic {
  stop(): void;
}

export function startMic(device: string, onChunk: (pcm: Buffer) => void, onError: (msg: string) => void): Mic {
  if (!ffmpegPath) throw new Error("ffmpeg-static has no binary for this platform");
  const child: ChildProcess = spawn(
    ffmpegPath,
    ["-hide_banner", "-loglevel", "error", "-f", "dshow", "-i", `audio=${device}`, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"],
    { windowsHide: true },
  );
  child.stdout!.on("data", (d: Buffer) => onChunk(d));
  child.stderr!.on("data", (d: Buffer) => onError(d.toString().trim()));
  child.on("exit", (code) => {
    if (code !== 0 && code !== null) onError(`microphone capture stopped (exit ${code})`);
  });
  return { stop: () => child.kill() };
}

/** Lists DirectShow audio devices, for finding the JARVIS_MIC value. */
export function listMicDevices(): Promise<string[]> {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve([]);
    const child = spawn(ffmpegPath, ["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"], { windowsHide: true });
    let out = "";
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("close", () => {
      const names = [...out.matchAll(/"([^"]+)"\s+\(audio\)/g)].map((m) => m[1]);
      resolve(names);
    });
  });
}
