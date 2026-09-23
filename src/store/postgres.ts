import { Pool, PoolClient } from "pg";
import type { ChainPair, ChainPairRecord, QueryDef, SwapEvent } from "../domain.js";
import { Store } from "./index.js";
import postgres from "postgres";

export const EVENT_TABLE = "events";

export const EXECUTIONS_TABLE = "swaps_executions";
export const EXECUTIONS_COLUMNS = ["id", "expires_at"] as const;

export const CHAIN_PAIRS_TABLE = "chain_pairs";
export const CHAIN_PAIRS_COLUMNS = ["execution_id", "chain", "pair", "expires_at"] as const;

// Postgres' wire protocol caps a single query at 65535 bind parameters
// (int16 count in the Bind message) — applies to every Postgres driver.
const MAX_BIND_PARAMS = 65535;

/** Splits rows into chunks that stay under Postgres' per-query bind-param
 * limit, given `columns` parameters per row. */
function chunkForParamLimit<T>(rows: readonly T[], columns: number): T[][] {
  const maxRowsPerChunk = Math.max(1, Math.floor(MAX_BIND_PARAMS / columns));
  if (rows.length <= maxRowsPerChunk) {
    return [rows as T[]];
  }
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += maxRowsPerChunk) {
    chunks.push(rows.slice(i, i + maxRowsPerChunk) as T[]);
  }
  return chunks;
}

export const EVENT_COLUMNS = [
  "chain",
  "pair",
  "id",
  "block_number",
  "log_index",
  "timestamp",
  "type",
  "amount_token",
  "amount_eth",
  "amount_ref",
  "price",
  "price_eth",
  "amount_usd",
  "event_liquidity",
  "amount_lp_token",
  "maker",
  "bot",
  "bot_address",
  "scamwick",
] as const;

/** Encodes a SwapEvent as a row of values in EVENT_COLUMNS order. */
export function toEventRow(s: SwapEvent): unknown[] {
  return [
    s.chain,
    s.pair,
    s.id,
    s.blockNumber,
    s.logIndex,
    new Date(s.timestamp * 1000),
    s.type,
    s.amountToken,
    s.amountEth,
    s.amountRef,
    s.price,
    s.priceEth,
    s.amountUsd,
    s.eventLiquidity,
    s.amountLpToken,
    s.maker,
    s.bot,
    s.botAddress,
    s.scamwick,
  ];
}

interface InflightBatch {
  table: string;
  columns: readonly string[];
  rows: unknown[][];
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout;
}

abstract class PostgresStore implements Store {
  private queriesByName = new Map<string, QueryDef>();
  private inflight?: Record<string, InflightBatch>;
  private readonly batchIntervalMs = 250;
  private readonly maxBatchSize = 1000;

  constructor (insertInBatches: boolean) {
    if (insertInBatches) {
      this.inflight = {};
    }
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;

  setQueries(queries: QueryDef[]): void {
    this.queriesByName = new Map(queries.map((q) => [q.name, q]));
  }

  async init(pairs: ChainPair[], executionId: string, expiresAt: Date): Promise<void> {
    await this.connect();
    await this.execute('shared', `DELETE FROM ${CHAIN_PAIRS_TABLE} WHERE expires_at < now()`, []);
    await this.execute('shared', `DELETE FROM ${EXECUTIONS_TABLE} WHERE expires_at < now()`, []);

    await this.insertMany('shared', EXECUTIONS_TABLE, EXECUTIONS_COLUMNS, [[executionId, expiresAt]]);
    await this.insertMany(
      'shared',
      CHAIN_PAIRS_TABLE,
      CHAIN_PAIRS_COLUMNS,
      pairs.map((p) => [executionId, p.chain, p.pair, expiresAt]),
    );
  }

  /** Inserts rows in as few statements as possible while staying under the
   * bind-param limit — `chain_pairs` can be thousands of rows per chain, so
   * a single unchunked INSERT can silently exceed the wire-protocol's
   * 65535-parameter cap and corrupt the Bind message. */
  private async insertMany(chain: string, table: string, columns: readonly string[], rows: unknown[][]): Promise<void> {
    if (rows.length === 0) return;
    for (const chunk of chunkForParamLimit(rows, columns.length)) {
      await this.insertChunk(chain, table, columns, chunk);
    }
  }

  async close(executionId?: string): Promise<void> {
    if (executionId) {
      await this.execute('shared', `DELETE FROM ${CHAIN_PAIRS_TABLE} WHERE execution_id = $1`, [executionId]);
      await this.execute('shared', `DELETE FROM ${EXECUTIONS_TABLE} WHERE id = $1`, [executionId]);
    }
    await this.disconnect();
  }

  // Only ever reads (chain, pair) rows belonging to currently-valid (not
  // past their TTL) executions, joined against EXECUTIONS_TABLE, so callers
  // never see combinations from a run that expired since the last cleanup.
  async fetchCurrentChainPairs(): Promise<ChainPairRecord[]> {
    const rows = await this.fetchAll<{ execution_id: string; chain: string; pair: string }>(
      'shared',
      `SELECT cp.execution_id, cp.chain, cp.pair FROM ${CHAIN_PAIRS_TABLE} cp
       INNER JOIN ${EXECUTIONS_TABLE} e ON e.id = cp.execution_id
       WHERE e.expires_at >= now()`,
      [],
    );
    return rows.map((r) => ({ executionId: r.execution_id, chain: r.chain, pair: r.pair }));
  }

  async insertSwap(swap: SwapEvent): Promise<void> {
    const row = toEventRow(swap);
    if (this.inflight) {
      let batch = this.inflight[swap.chain];
      if (!batch) {
        let resolve!: () => void;
        let reject!: (err: unknown) => void;
        const promise = new Promise<void>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        batch = {
          table: EVENT_TABLE,
          columns: EVENT_COLUMNS,
          rows: [],
          promise,
          resolve,
          reject,
          timer: setTimeout(() => this.flush(swap.chain), this.batchIntervalMs),
        };
        this.inflight[swap.chain] = batch;
      }
      batch.rows.push(row);
      if (batch.rows.length >= this.maxBatchSize) {
        clearTimeout(batch.timer);
        void this.flush(swap.chain);
      }
      return batch.promise;
    }
    await this.insertRow(swap.chain, EVENT_TABLE, EVENT_COLUMNS, row);
  }

  private async flush(chain: string): Promise<void> {
    const batch = this.inflight![chain];
    if (!batch) return;
    delete this.inflight![chain];
    try {
      for (const chunk of chunkForParamLimit(batch.rows, batch.columns.length)) {
        await this.insertChunk(chain, batch.table, batch.columns, chunk);
      }
      batch.resolve();
    } catch (err) {
      batch.reject(err);
    }
  }

  async query(chain: string, name: string, params: readonly unknown[]): Promise<number> {
    const def = this.queriesByName.get(name);
    if (!def) {
      throw new Error(`unknown query "${name}"`);
    }
    const rows = await this.execute(chain, def.sql, params);
    return rows.length;
  }

  async fetchAll<T>(chain: string, sql: string, params: readonly unknown[]): Promise<T[]> {
    return await this.execute<T>(chain, sql, params);
  }

  protected abstract insertChunk(chain: string, table: string, columns: readonly string[], rows: unknown[][]): Promise<void>;

  protected abstract insertRow(chain: string, table: string, columns: readonly string[], row: unknown[]): Promise<void>;

  protected abstract execute<T>(chain: string, sql: string, params: readonly unknown[]): Promise<T[]>;
}

export class PgStore extends PostgresStore {
  private readonly pool: Pool;

  constructor(connectionString: string, poolSize: number, insertInBatches: boolean) {
    super(insertInBatches);
    this.pool = new Pool({ connectionString, max: poolSize });
  }

  async connect(): Promise<void> { }

  protected async insertChunk(chain: string, table: string, columns: readonly string[], rows: unknown[][]): Promise<void> {
    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];
    let p = 1;
    for (const row of rows) {
      rowPlaceholders.push(`(${columns.map(() => `$${p++}`).join(",")})`);
      values.push(...row);
    }

    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${rowPlaceholders.join(",")}`;
    await this.pool.query(sql, values);
  }

  protected async insertRow(chain: string, table: string, columns: readonly string[], row: unknown[]): Promise<void> {
    return this.insertChunk(chain, table, columns, [row]);
  }

  protected async execute<T>(chain: string, sql: string, params: readonly unknown[]): Promise<T[]> {
    const res = await this.pool.query(sql, params as unknown[]);
    return res.rows as T[];
  }

  async disconnect(): Promise<void> {
    await this.pool.end();
  }
}

/** Store backed by postgres.js. `poolSize` should match the number of
 * concurrent producers/clients, same reasoning as the pg implementation. */
export class PostgresJsStore extends PostgresStore {
  private readonly sql: postgres.Sql;

  constructor(connectionString: string, poolSize: number, insertInBatches: boolean) {
    super(insertInBatches);
    this.sql = postgres(connectionString, { max: poolSize });
  }

  async connect(): Promise<void> {
    await this.sql`SELECT 1`;
  }

  protected async insertChunk(chain: string, table: string, columns: readonly string[], rows: unknown[][]): Promise<void> {
    const objects = rows.map((row) => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
    await this.sql`INSERT INTO ${this.sql(table)} ${this.sql(objects, ...(columns as string[]))}`;
  }

  // sql() accepts a single object directly (not just an array of objects),
  // so a lone row doesn't need to be wrapped in a one-element array the way
  // insertChunk's bulk path requires.
  protected async insertRow(chain: string, table: string, columns: readonly string[], row: unknown[]): Promise<void> {
    const object = Object.fromEntries(columns.map((col, i) => [col, row[i]]));
    await this.sql`INSERT INTO ${this.sql(table)} ${this.sql(object, ...(columns as string[]))}`;
  }

  // Query text is only known at runtime (it comes from the query load
  // tester's query pool), so this uses `sql.unsafe` — postgres.js's escape
  // hatch for dynamic/raw SQL — rather than a tagged template.
  protected async execute<T>(chain: string, sql: string, params: readonly unknown[]): Promise<T[]> {
    const rows = await this.sql.unsafe(sql, params as postgres.ParameterOrJSON<never>[]);
    return rows as unknown as T[];
  }

  async disconnect(): Promise<void> {
    await this.sql.end();
  }
}
