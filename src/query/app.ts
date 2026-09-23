import { LiveProgress, repeatChar } from "../liveProgress.js";
import type { ChainPair } from "../domain.js";
import type { QueryConfig } from "./config.js";
import { needsChainPair, resolveParams } from "./placeholders.js";
import type { QueryDef } from "./queries.js";
import { LatencyStats, type LiveStats } from "../stats.js";
import { createStore, type Store } from "../store/index.js";
import { createEventLoopUtilization, type EventLoopUtilizationSnapshot } from "../eventLoopUtilization.js";

const SUMMARY_COLUMNS = ["Query", "Count", "Errors", "Avg(ms)", "Min(ms)", "Max(ms)", "AvgRows", "MinRows", "MaxRows"];
const SUMMARY_COL_WIDTH = 10;

function fmtMs(ms: number): string {
  return ms.toFixed(2);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runQueryLoad(cfg: QueryConfig, queries: QueryDef[]): Promise<void> {
  const startTime = Date.now();

  console.log();
  const rateLabel = cfg.queriesPerSecond > 0 ? `${cfg.queriesPerSecond}/s/client` : "unthrottled";
  console.log(
    `QUERY LOAD TEST: clients=${cfg.numClients} | rate=${rateLabel} | rate_multiplier=${cfg.rateMultiplier}x | ` +
      `driver=${cfg.driver} | queries=${queries.length} | started=${new Date(startTime).toISOString()}`,
  );
  console.log(cfg.durationSec > 0 ? `  duration=${cfg.durationSec}s` : "  duration=until interrupted (Ctrl+C)");
  console.log();

  const eventLoopUtilization = createEventLoopUtilization();
  eventLoopUtilization.start();

  const store = createStore(cfg.driver, cfg.timescaleUrl, cfg.numClients, false);
  await store.connect();
  store.setQueries(queries);

  // Only pull chain/pairs from executions that are still current (not past
  // their TTL) — the store owns what "still valid" means for whatever
  // storage technology it's backed by, so query works over currently-stored
  // swaps without needing to know anything about how that's tracked.
  const currentRows = await store.fetchCurrentChainPairs();
  const chainPairs: ChainPair[] = currentRows.map(({ chain, pair }) => ({ chain, pair }));
  const executionCount = new Set(currentRows.map((r) => r.executionId)).size;
  if (chainPairs.length === 0 && queries.some((q) => needsChainPair(q.params ?? []))) {
    console.log(
      "Warning: no currently running swaps execution has published (chain,pair) combinations — " +
        "some queries use $chain/$pair and will fail. Run the swaps generator first.",
    );
  } else {
    console.log(`Loaded ${chainPairs.length} (chain,pair) combinations from ${executionCount} running execution(s)`);
  }
  console.log();

  const stats = new LatencyStats(queries.map((q) => q.name));
  const rowStats = new LatencyStats(queries.map((q) => q.name));

  // --- shutdown wiring: duration timeout and SIGINT both stop clients ---
  let stopped = false;
  let status = "Running";
  let resolveStopped: () => void;
  const stoppedPromise = new Promise<void>((resolve) => {
    resolveStopped = resolve;
  });

  const stop = (reason: string) => {
    if (stopped) return;
    stopped = true;
    status = reason;
    resolveStopped();
  };

  let durationTimer: NodeJS.Timeout | null = null;
  if (cfg.durationSec > 0) {
    durationTimer = setTimeout(() => stop("Duration reached — draining"), cfg.durationSec * 1000);
  }
  const onSigint = () => stop("Interrupted — draining");
  process.on("SIGINT", onSigint);

  const progress = new LiveProgress(
    (lp) => renderQueryProgress(lp, queries, stats, rowStats, () => status, eventLoopUtilization.snapshot()),
    cfg.durationSec > 0 ? cfg.durationSec * 1000 : 0
  );
  progress.start(500);

  const clients = Array.from({ length: cfg.numClients }, () =>
    runClient(cfg, queries, store, stats, rowStats, chainPairs, () => stopped),
  );

  await stoppedPromise;
  await Promise.all(clients);

  if (durationTimer) clearTimeout(durationTimer);
  process.off("SIGINT", onSigint);
  await progress.stopAndWait();
  eventLoopUtilization.stop();

  printFinalReport(Date.now() - startTime, status, stats);
  await store.close();
}

async function runClient(
  cfg: QueryConfig,
  queries: QueryDef[],
  store: Store,
  stats: LatencyStats,
  rowStats: LatencyStats,
  chainPairs: ChainPair[],
  isStopped: () => boolean,
): Promise<void> {
  const intervalMs = cfg.queriesPerSecond > 0 ? 1000 / cfg.queriesPerSecond : 0;

  while (!isStopped()) {
    const iterationStart = Date.now();
    const q = queries[Math.floor(Math.random() * queries.length)];
    const startNs = process.hrtime.bigint();
    try {
      const { chain, params } = resolveParams(q.params ?? [], chainPairs);
      const rowCount = await store.query(chain, q.name, params);
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      stats.record(q.name, elapsedMs);
      rowStats.record(q.name, rowCount);
    } catch(error) {
      stats.recordError(q.name);
    }

    if (intervalMs > 0) {
      const waitMs = intervalMs - (Date.now() - iterationStart);
      if (waitMs > 0) await sleep(waitMs);
    }
  }
}

function renderQueryProgress(
  lp: LiveProgress,
  queries: QueryDef[],
  stats: LatencyStats,
  rowStats: LatencyStats,
  getStatus: () => string,
  eventLoopUtilization: EventLoopUtilizationSnapshot,
): number {
  const nameWidth = Math.max(SUMMARY_COLUMNS[0].length, "TOTAL".length, ...queries.map((q) => q.name.length));
  const tableWidth = nameWidth + (SUMMARY_COLUMNS.length - 1) * (SUMMARY_COL_WIDTH + 1);
  let lines = 0;
  lines += lp.liveLine("%s", formatHeader(nameWidth));
  lines += lp.liveLine("%s", repeatChar("-", tableWidth));

  for (const q of queries) {
    lines += lp.liveLine("%s", formatRow(q.name, stats.live(q.name), rowStats.live(q.name), nameWidth));
  }
  lines += lp.liveLine("%s", repeatChar("-", tableWidth));
  const total = stats.liveTotal();
  lines += lp.liveLine("%s", formatRow("TOTAL", total, rowStats.liveTotal(), nameWidth));
  lines += lp.liveLine("");

  lines += lp.liveLine(
    "Event loop utilization: %s%; Max: %s%, Avg: %s%",
    eventLoopUtilization.utilizationPct.toFixed(1),
    eventLoopUtilization.maxUtilizationPct.toFixed(1),
    eventLoopUtilization.avgUtilizationPct.toFixed(1));
  lines += lp.liveLine("Status: %s", getStatus());
  return lines;
}

/** Prints the elapsed/throughput summary after the run — the live view's
 * last frame (from progress.stopAndWait()) already froze the final table on
 * screen, so this deliberately doesn't reprint it (that would show the same
 * table twice). */
function printFinalReport(elapsedMs: number, status: string, stats: LatencyStats): void {
  console.log();
  if (status === "Interrupted — draining") {
    console.log("Interrupted — showing partial results above.");
  }
  const elapsedSec = elapsedMs / 1000;
  const total = stats.liveTotal();
  const throughput = elapsedSec > 0 ? total.count / elapsedSec : 0;
  console.log(`Elapsed: ${elapsedSec.toFixed(1)}s | Throughput: ${throughput.toFixed(1)} queries/sec`);
  if (total.errors > 0) {
    console.log(`Dropped ${total.errors} queries (failed and were never completed).`);
  }
}

function formatHeader(nameWidth: number): string {
  const [first, ...rest] = SUMMARY_COLUMNS;
  return [first.padStart(nameWidth), ...rest.map((h) => h.padStart(SUMMARY_COL_WIDTH))].join(" ");
}

/** One row combining query-latency (ms) and rows-returned stats for a
 * single query name (or "TOTAL"). Shared by the live view and final report
 * so the two never drift out of sync. */
function formatRow(name: string, s: LiveStats, r: LiveStats, nameWidth: number): string {
  const pad = (v: string) => v.padStart(SUMMARY_COL_WIDTH);
  return [
    name.padStart(nameWidth),
    pad(String(s.count)),
    pad(String(s.errors)),
    pad(fmtMs(s.avg)),
    pad(fmtMs(s.min)),
    pad(fmtMs(s.max)),
    pad(r.avg.toFixed(1)),
    pad(String(r.min)),
    pad(String(r.max)),
  ].join(" ");
}
