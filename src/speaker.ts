import { spawn, type ChildProcess } from "child_process";

/**
 * Plays raw PCM (24 kHz, mono, s16le) through ffplay.
 * - write(): feeds the current player, starting one if needed.
 * - finish(): no more audio for now; the player plays what it has and exits on its own.
 * - stop(): cancels at once (barge-in), including audio still draining.
 */
export class Speaker {
  private current: ChildProcess | null = null;
  private draining = new Set<ChildProcess>();

  constructor(private readonly ffplay: string) {}

  write(pcm: Buffer): void {
    if (!this.current) this.current = this.start();
    this.current.stdin?.write(pcm);
  }

  finish(): void {
    const p = this.current;
    if (!p) return;
    this.current = null;
    this.draining.add(p);
    p.stdin?.end();
  }

  stop(): void {
    for (const p of [this.current, ...this.draining]) {
      if (p) {
        p.stdin?.destroy();
        p.kill();
      }
    }
    this.current = null;
    this.draining.clear();
  }

  /** True while any audio is still going out. */
  get active(): boolean {
    return this.current !== null || this.draining.size > 0;
  }

  private start(): ChildProcess {
    const p = spawn(
      this.ffplay,
      // FFmpeg 7+ removed -ac as an input option; -ch_layout is the replacement. -autoexit lets a
      // finished player drain and exit on its own after stdin closes.
      ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", "-fflags", "nobuffer", "-probesize", "32", "-analyzeduration", "0", "-f", "s16le", "-ar", "24000", "-ch_layout", "mono", "-i", "-"],
      { windowsHide: true, stdio: ["pipe", "ignore", "ignore"] },
    );
    p.stdin?.on("error", () => {});
    p.on("exit", () => {
      this.draining.delete(p);
      if (this.current === p) this.current = null;
    });
    return p;
  }
}
