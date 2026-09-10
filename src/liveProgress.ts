/** Renders a dynamic in-place table by calling a user-provided renderFn.
 * renderFn must return the number of lines it printed so the next render can
 * overwrite them, via ANSI cursor-up escapes. */
export class LiveProgress {
  private lines = 0;
  private startTime = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly renderFn: (lp: LiveProgress) => number,
    private readonly totalDurationMs: number, // 0 means unknown
  ) {}

  start(intervalMs: number): void {
    this.startTime = Date.now();
    this.timer = setInterval(() => this.render(), intervalMs);
  }

  async stopAndWait(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.render();
  }

  render(): void {
    if (this.lines > 0) {
      process.stdout.write(`\x1b[${this.lines}A`);
    }
    this.lines = this.renderFn(this);

    const elapsedMs = Date.now() - this.startTime;
    if (this.totalDurationMs > 0) {
      const remainingMs = Math.max(0, this.totalDurationMs - elapsedMs);
      this.lines += this.liveLine(
        "Elapsed: %s / %s  (remaining: %s)",
        formatDuration(elapsedMs),
        formatDuration(this.totalDurationMs),
        formatDuration(remainingMs),
      );
    } else {
      this.lines += this.liveLine("Elapsed: %s", formatDuration(elapsedMs));
    }
  }

  /** Prints one line, clearing the rest of the row first. Returns 1 for line counting. */
  liveLine(format: string, ...args: unknown[]): number {
    process.stdout.write(`\x1b[2K${sprintf(format, args)}\n`);
    return 1;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}h${pad(m)}m${pad(s)}s` : `${m}m${pad(s)}s`;
}

/** Minimal printf-style formatter: supports %s, %d, %-Ns, %Nd. */
function sprintf(format: string, args: unknown[]): string {
  let i = 0;
  return format.replace(/%(-?\d+)?([sd])/g, (_match, width: string | undefined, kind: string) => {
    const arg = args[i++];
    let str = kind === "d" ? String(Math.trunc(Number(arg))) : String(arg);
    if (width) {
      const w = parseInt(width, 10);
      const left = w < 0;
      const n = Math.abs(w);
      str = left ? str.padEnd(n, " ") : str.padStart(n, " ");
    }
    return str;
  });
}

export function repeatChar(c: string, n: number): string {
  return c.repeat(n);
}
