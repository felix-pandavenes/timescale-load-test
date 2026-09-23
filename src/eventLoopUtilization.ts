import { performance, type EventLoopUtilization as NodeEventLoopUtilization } from "node:perf_hooks";

export interface EventLoopUtilizationSnapshot {
  activeMs: number;
  idleMs: number;
  utilizationPct: number;
  avgUtilizationPct: number;
  minUtilizationPct: number;
  maxUtilizationPct: number;
}

/** Tracks Node's event-loop utilization — what share of the time since
 * start() this process' event loop has spent actively doing work, as
 * opposed to idle waiting for I/O. Read this next to write/query latency
 * (src/stats.ts) to tell apart the two ways a load test can look slow:
 * high utilization while DB latency stays low means *this process* can't
 * generate/dispatch work fast enough (CPU-bound work, GC pauses, too many
 * timers) — the client is the bottleneck, not the database. Low
 * utilization with high DB latency means the opposite: this process is
 * mostly idle, waiting on a slow database. Cumulative since start() (like
 * LatencyStats elsewhere in this repo), not a rolling window. */
export interface EventLoopUtilization {
  start(): void;
  stop(): void;
  snapshot(): EventLoopUtilizationSnapshot;
}

const EMPTY_SNAPSHOT: EventLoopUtilizationSnapshot = { utilizationPct: 0, activeMs: 0, idleMs: 0, avgUtilizationPct: 0, minUtilizationPct: 0 , maxUtilizationPct: 0 };

export function createEventLoopUtilization(): EventLoopUtilization {
  let baseline: NodeEventLoopUtilization | null = null;
  let maxUtilizationPct = 0;
  let minUtilizationPct = 100;
  let totalUtilizationPct = 0;
  let numberOfSamples = 0;

  return {
    start: () => {
      baseline = performance.eventLoopUtilization();
    },
    stop: () => {
      baseline = null;
    },
    snapshot: () => {
      if (!baseline) return EMPTY_SNAPSHOT;
      const delta = performance.eventLoopUtilization(baseline);
      totalUtilizationPct += delta.utilization * 100;
      numberOfSamples++;
      maxUtilizationPct = Math.max(maxUtilizationPct, delta.utilization * 100);
      minUtilizationPct = Math.min(minUtilizationPct, delta.utilization * 100);
      return {
        utilizationPct: delta.utilization * 100,
        activeMs: delta.active,
        idleMs: delta.idle,
        maxUtilizationPct,
        minUtilizationPct,
        avgUtilizationPct: numberOfSamples > 0 ? totalUtilizationPct / numberOfSamples : 0,
      };
    },
  };
}
