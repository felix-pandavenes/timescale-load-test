import { readFileSync } from "node:fs";
import { isDriver, type Driver } from "../store/index.js";

/** Drives the query load tester: how many concurrent clients, how long they
 * run, which driver to use, and where the query pool lives. */
export interface QueryConfig {
  numClients: number;
  durationSec: number; // 0 = run until interrupted (Ctrl+C)
  queriesPerSecond: number; // per client, already scaled by rateMultiplier; 0 = unlimited, run back-to-back as fast as possible
  rateMultiplier: number; // scales queries_per_second; 1 = no change, 1.3 = 130%, 0.7 = 70%
  timescaleUrl: string;
  driver: Driver;
  queriesFile: string;
}

interface RawQueryConfig {
  num_clients?: number;
  duration_sec?: number;
  queries_per_second?: number;
  rate_multiplier?: number;
  timescale_url?: string;
  driver?: string;
}

const DEFAULT_TIMESCALE_URL = "postgres://postgres:postgres@localhost:5432/postgres?sslmode=disable";
const DEFAULT_PG_QUERIES_FILE = "config/pg-queries.json";
const DEFAULT_MONGO_QUERIES_FILE = "config/mongo-queries.json";

function applyDefaults(raw: RawQueryConfig): QueryConfig {
  const rateMultiplier = raw.rate_multiplier && raw.rate_multiplier > 0 ? raw.rate_multiplier : 1;
  const baseQueriesPerSecond = raw.queries_per_second && raw.queries_per_second > 0 ? raw.queries_per_second : 0;
  const driver = raw.driver && isDriver(raw.driver) ? raw.driver : "pg";
  const queriesFile = (process.env.QUERIES_FILE || (driver === "pg" || driver === "postgres" ? DEFAULT_PG_QUERIES_FILE : DEFAULT_MONGO_QUERIES_FILE)) as string;
  return {
    numClients: raw.num_clients && raw.num_clients > 0 ? raw.num_clients : 10,
    durationSec: raw.duration_sec ?? 0,
    queriesPerSecond: baseQueriesPerSecond * rateMultiplier,
    rateMultiplier,
    timescaleUrl: raw.timescale_url || process.env.TIMESCALE_URL || DEFAULT_TIMESCALE_URL,
    driver, 
    queriesFile,
  };
}

function validate(cfg: QueryConfig): void {
  if (cfg.numClients <= 0) {
    throw new Error("num_clients must be > 0");
  }
  if (cfg.rateMultiplier <= 0) {
    throw new Error("rate_multiplier must be > 0");
  }
}

/** Reads and validates the query-load-tester config at path. */
export function loadQueryConfig(path: string): QueryConfig {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read ${path}: ${(err as Error).message}`);
  }

  let parsed: RawQueryConfig;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${path}: ${(err as Error).message}`);
  }

  const cfg = applyDefaults(parsed);
  validate(cfg);
  return cfg;
}
