import { randomUUID } from "node:crypto";
import type { SwapsConfig } from "./config.js";
import { allChainPairs, pairCount, pairId, throughput } from "./config.js";
import { PairState } from "./generator.js";
import { LiveProgress, repeatChar } from "../liveProgress.js";
import { createStore, type Store } from "../store/index.js";
import { LatencyStats, type LiveStats } from "../stats.js";
import { createEventLoopUtilization, type EventLoopUtilizationSnapshot } from "../eventLoopUtilization.js";
import type { SwapEvent } from "../domain.js";

const EXECUTION_TTL_MS = 12 * 60 * 60 * 1000;

const CHAIN_COLUMNS = ["Chain", "Pairs", "Inserted", "Errors", "Avg(ms)", "Min(ms)", "Max(ms)"];
const CHAIN_COL_WIDTH = 10;

function fmtMs(ms: number): string {
  return ms.toFixed(2);
}

interface ChainStats {
  inserted: number;
  errors: number;
}

interface LiveSwapStats {
  perChain: Map<string, ChainStats>;
  status: string;
  dots: number;
}

export async function runSwaps(cfg: SwapsConfig): Promise<void> {
  const startTime = Date.now();
  const totalPairs = pairCount(cfg);
  const totalThroughput = throughput(cfg);
  const executionId = randomUUID();

  console.log();
  console.log(
    `SWAP GENERATOR: execution=${executionId} | chains=${cfg.chains.length} | pairs=${totalPairs} | throughput=${totalThroughput} s/s | ` +
      `driver=${cfg.driver} | rate_multiplier=${cfg.rateMultiplier}x | insert_in_batches=${cfg.insertInBatches} | ` +
      `started=${new Date(startTime).toISOString()} ` + (cfg.durationSec > 0 ? `  duration=${cfg.durationSec}s` : "  duration=until interrupted (Ctrl+C)"),
  );
  console.log();

  const chainIds = cfg.chains.map((c) => c.id);
  const live: LiveSwapStats = {
    perChain: new Map(chainIds.map((id) => [id, { inserted: 0, errors: 0 }])),
    status: "Running",
    dots: 0,
  };

  const writeStats = new LatencyStats(chainIds);
  const inFlight = new Set<Promise<void>>();

  // --- shutdown wiring: duration timeout and SIGINT both stop generators ---
  let generatorsStopped = false;
  const generatorTimers: NodeJS.Timeout[] = [];
  let resolveGeneratorsStopped: () => void;
  const generatorsStoppedPromise = new Promise<void>((resolve) => {
    resolveGeneratorsStopped = resolve;
  });

  const stopGenerators = (reason: string) => {
    if (generatorsStopped) return;
    generatorsStopped = true;
    live.status = reason;
    for (const t of generatorTimers) clearInterval(t);
    resolveGeneratorsStopped();
  };

  let durationTimer: NodeJS.Timeout | null = null;
  if (cfg.durationSec > 0) {
    durationTimer = setTimeout(() => stopGenerators("Duration reached — draining"), cfg.durationSec * 1000);
  }
  const onSigint = () => stopGenerators("Interrupted — draining");
  process.on("SIGINT", onSigint);

  const store = await initStore(executionId, cfg);
  const eventLoopUtilization = createEventLoopUtilization();
  eventLoopUtilization.start();

  for (const chain of cfg.chains) {
    const stats = live.perChain.get(chain.id)!;
    const states = Array.from({ length: chain.numPairs }, () => new PairState());
    let nextPair = 0;
    const intervalMs = 1000 / chain.swapsPerSecond;
    const timer = setInterval(() => {
      if (generatorsStopped) return;
      const i = nextPair;
      nextPair = (nextPair + 1) % chain.numPairs;
      const swap: SwapEvent = { ...states[i].next(), chain: chain.id, pair: pairId(chain.id, i) };
      const p = insertSwap(store, chain.id, swap, stats, writeStats).finally(() => inFlight.delete(p));
      inFlight.add(p);
    }, intervalMs);
    generatorTimers.push(timer);
  }

  const progress = new LiveProgress(
    (lp) => renderSwapProgress(lp, cfg, chainIds, live, writeStats, eventLoopUtilization.snapshot()),
    cfg.durationSec > 0 ? cfg.durationSec * 1000 : 0
  );
  progress.start(500);

  // Wait for generators to stop (duration/SIGINT), then for every insert
  // that had already started to finish (or fail).
  await generatorsStoppedPromise;
  await Promise.all(inFlight);

  if (durationTimer) clearTimeout(durationTimer);
  process.off("SIGINT", onSigint);

  await progress.stopAndWait();
  eventLoopUtilization.stop();

  await store.close(executionId);

  // The live view's last frame (just printed by stopAndWait() above) already
  // shows the final per-chain table with its TOTAL row — deliberately not
  // reprinted here, only the one-off "run finished" line.
  console.log();
  const elapsedSec = Math.round((Date.now() - startTime) / 1000);
  const totalInserted = [...live.perChain.values()].reduce((n, s) => n + s.inserted, 0);
  const totalErrors = [...live.perChain.values()].reduce((n, s) => n + s.errors, 0);
  console.log(
    `Done: execution=${executionId} | chains=${cfg.chains.length} | pairs=${totalPairs} | insert_in_batches=${cfg.insertInBatches} | ` +
      `driver=${cfg.driver} | rate_multiplier=${cfg.rateMultiplier}x | `
  );
  console.log(
    `Summary: inserted=${totalInserted} | errors=${totalErrors} | throughput=${totalThroughput} s/s | ` +
      `started=${new Date(startTime).toISOString()} | ended=${new Date().toISOString()} | duration: ${elapsedSec}s`,
  );

  console.log();
}

async function initStore(executionId: string, cfg: SwapsConfig): Promise<Store> {
  const pairs = allChainPairs(cfg);
  const expiresAt = new Date(Date.now() + EXECUTION_TTL_MS);
  const store = createStore(cfg.driver, cfg.timescaleUrl, cfg.chains.length, cfg.insertInBatches);
  await store.init(pairs, executionId, expiresAt);

  console.log(`Published ${pairs.length} (chain,pair) combinations to store (execution ${executionId})`);

  return store;
}

/** Inserts one swap and times it — this is what "how many seconds does the
 * database take to return" measures directly, with no queue or batching in
 * between. Runs detached from the generator's setInterval tick
 * (fire-and-forget from the caller's perspective), so errors are caught and
 * counted here rather than crashing the process. */
async function insertSwap(
  store: Store,
  chainId: string,
  swap: SwapEvent,
  stats: ChainStats,
  writeStats: LatencyStats,
): Promise<void> {
  const startNs = process.hrtime.bigint();
  try {
    await store.insertSwap(swap);
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
    stats.inserted++;
    writeStats.record(chainId, elapsedMs);
  } catch(error) {
    console.log(`Error: ${(error as Error).stack}`);
    stats.errors++;
    if (stats.errors > 10) {
      process.exit(1);
    }
  }
}

function formatChainHeader(nameWidth: number): string {
  const [first, ...rest] = CHAIN_COLUMNS;
  return [first.padStart(nameWidth), ...rest.map((h) => h.padStart(CHAIN_COL_WIDTH))].join(" ");
}

/** One row combining inserted/errors counts and write-latency (ms)
 * stats for a single chain (or "TOTAL"). */
function formatChainRow(name: string, pairs: number, s: ChainStats, w: LiveStats, nameWidth: number): string {
  const pad = (v: string) => v.padStart(CHAIN_COL_WIDTH);
  return [
    name.padStart(nameWidth),
    pad(String(pairs)),
    pad(String(s.inserted)),
    pad(String(s.errors)),
    pad(fmtMs(w.avg)),
    pad(fmtMs(w.min)),
    pad(fmtMs(w.max)),
  ].join(" ");
}

function renderSwapProgress(
  lp: LiveProgress,
  cfg: SwapsConfig,
  chainIds: string[],
  live: LiveSwapStats,
  writeStats: LatencyStats,
  eventLoopUtilization: EventLoopUtilizationSnapshot,
): number {
  const nameWidth = Math.max(CHAIN_COLUMNS[0].length, "TOTAL".length, ...chainIds.map((id) => id.length));
  const chainTableWidth = nameWidth + (CHAIN_COLUMNS.length - 1) * (CHAIN_COL_WIDTH + 1);
  let lines = 0;
  lines += lp.liveLine("%s", formatChainHeader(nameWidth));
  lines += lp.liveLine("%s", repeatChar("-", chainTableWidth));

  let totalPairs = 0;
  cfg.chains.forEach((chain, i) => {
    const s = live.perChain.get(chainIds[i])!;
    const w = writeStats.live(chainIds[i]);
    totalPairs += chain.numPairs;
    lines += lp.liveLine("%s", formatChainRow(chainIds[i], chain.numPairs, s, w, nameWidth));
  });
  lines += lp.liveLine("%s", repeatChar("-", chainTableWidth));

  const totalStats: ChainStats = { inserted: 0, errors: 0 };
  for (const s of live.perChain.values()) {
    totalStats.inserted += s.inserted;
    totalStats.errors += s.errors;
  }
  lines += lp.liveLine("%s", formatChainRow("TOTAL", totalPairs, totalStats, writeStats.liveTotal(), nameWidth));
  lines += lp.liveLine("");

  lines += lp.liveLine(
    "Event loop utilization: %s%; Avg: %s%, Min: %s%, Max: %s%",
    eventLoopUtilization.utilizationPct.toFixed(1),
    eventLoopUtilization.avgUtilizationPct.toFixed(1),
    eventLoopUtilization.minUtilizationPct.toFixed(1),
    eventLoopUtilization.maxUtilizationPct.toFixed(1));
  lines += lp.liveLine("Status: %s %s", live.status, repeatChar(".", live.dots));
  live.dots = live.dots + 1 > 3 ? 0 : live.dots + 1;
  return lines;
}
