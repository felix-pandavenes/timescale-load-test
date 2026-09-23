import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ChainPair } from "../domain.js";
import { isDriver, type Driver } from "../store/index.js";

export type { Driver } from "../store/index.js";

/** A chain to simulate: how many pairs it has and the chain's *total* swap
 * rate, split evenly across its pairs (so 10 pairs at 10 swaps_per_second
 * means 1 swap/sec per pair, not 10 each). `swapsPerSecond` here is already
 * the effective rate — `rate_multiplier` (see SwapsConfig) has been applied
 * to it, it's not the literal JSON value. Pair IDs are auto-generated
 * ("pair-0".."pair-(numPairs-1)"). */
export interface ChainConfig {
  id: string;
  numPairs: number;
  swapsPerSecond: number;
}

/** Drives the swap generator: which chains to simulate, how many pairs and at
 * what rate each chain produces swaps, and where to persist swaps. Each
 * generated swap is inserted directly (one INSERT per swap, no
 * queue/batching) — see `src/swaps/app.ts`. There's no pool-size knob: the
 * DB connection pool is sized to `chains.length` (see `app.ts`) so every
 * chain always has its own connection and is never throttled waiting on
 * another chain's in-flight insert. */
export interface SwapsConfig {
  durationSec: number; // 0 = run until interrupted (Ctrl+C)
  timescaleUrl: string;
  rateMultiplier: number; // scales every chain's swaps_per_second; 1 = no change, 1.3 = 130%, 0.7 = 70%
  insertInBatches: boolean;
  driver: Driver;
  chains: ChainConfig[];
}

interface RawChainConfig {
  id?: string;
  num_pairs?: number;
  swaps_per_second?: number;
}

interface RawSwapsConfig {
  duration_sec?: number;
  timescale_url?: string;
  rate_multiplier?: number;
  insert_in_batches?: boolean;
  driver?: string;
  chains?: RawChainConfig[];
}

const DEFAULT_TIMESCALE_URL = "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable";

function applyDefaults(raw: RawSwapsConfig): SwapsConfig {
  const rateMultiplier = raw.rate_multiplier && raw.rate_multiplier > 0 ? raw.rate_multiplier : 1;
  return {
    durationSec: raw.duration_sec ?? 0,
    timescaleUrl: raw.timescale_url || process.env.TIMESCALE_URL || DEFAULT_TIMESCALE_URL,
    rateMultiplier,
    insertInBatches: raw.insert_in_batches ?? false,
    driver: raw.driver && isDriver(raw.driver) ? raw.driver : "pg",
    chains: (raw.chains ?? []).map((c) => ({
      id: c.id ?? "",
      numPairs: c.num_pairs ?? 0,
      swapsPerSecond: (c.swaps_per_second ?? 0) * rateMultiplier,
    })),
  };
}

function validate(cfg: SwapsConfig): void {
  if (cfg.chains.length === 0) {
    throw new Error("at least one chain is required");
  }
  if (cfg.rateMultiplier <= 0) {
    throw new Error("rate_multiplier must be > 0");
  }

  const seenChains = new Set<string>();
  for (const chain of cfg.chains) {
    if (!chain.id) {
      throw new Error("chain is missing required 'id' field");
    }
    if (seenChains.has(chain.id)) {
      throw new Error(`duplicate chain id "${chain.id}"`);
    }
    seenChains.add(chain.id);

    if (chain.numPairs <= 0) {
      throw new Error(`chain "${chain.id}": num_pairs must be > 0`);
    }
    if (chain.swapsPerSecond <= 0) {
      throw new Error(`chain "${chain.id}": swaps_per_second must be > 0`);
    }
  }
}

/** Reads and validates the swap-generator config at path. */
export function loadSwapsConfig(path: string): SwapsConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: RawSwapsConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }

  const cfg = applyDefaults(parsed);
  validate(cfg);
  return cfg;
}

/** Total number of pairs across all chains. */
export function pairCount(cfg: SwapsConfig): number {
  return cfg.chains.reduce((n, chain) => n + chain.numPairs, 0);
}

export function throughput(cfg: SwapsConfig): number {
  return cfg.chains.reduce((n, chain) => n + chain.swapsPerSecond, 0);
}

/** The deterministic pair ID for the i-th pair of a chain: a SHA-256 hash of
 * `${chain}-${index}`, encoded in a 64-character alphabet (base64url)
 * rather than hex, to keep it compact. Deterministic on purpose — the same
 * (chain, index) always hashes to the same ID across separate `swaps` runs
 * (unlike a random ID), so the database keeps accumulating real history
 * under a stable set of pair identities instead of scattering rows across
 * a fresh, disjoint set of pair IDs every run. Single source of truth for
 * this naming, used both by the generator's per-pair state and by
 * allChainPairs() below, so they can never drift apart. */
export function pairId(chain: string, index: number): string {
  return createHash("sha256").update(`${chain}-${index}`).digest("base64url");
}

/** Every (chain, pair) combination this config simulates. */
export function allChainPairs(cfg: SwapsConfig): ChainPair[] {
  return cfg.chains.flatMap((chain) =>
    Array.from({ length: chain.numPairs }, (_, i) => ({ chain: chain.id, pair: pairId(chain.id, i) })),
  );
}
