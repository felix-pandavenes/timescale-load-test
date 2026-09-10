import { PgStore , PostgresJsStore } from "./postgres.js";
import { MongoStore } from "./mongodb.js";
import type { ChainPair, ChainPairRecord, QueryDef, SwapEvent } from "../domain.js";


export type Driver = "pg" | "postgres" | "mongodb";

const DRIVERS: readonly Driver[] = ["pg", "postgres", "mongodb"];

export function isDriver(value: string): value is Driver {
  return (DRIVERS as readonly string[]).includes(value);
}

export interface Store {
  connect(): Promise<void>;
  init(pairs: ChainPair[], executionId: string, expiresAt: Date): Promise<void>;
  insertSwap(swap: SwapEvent): Promise<void>;
  /** Registers the query pool so `query(name, ...)` can resolve names to
   * SQL/whatever the underlying storage technology needs — callers only
   * ever refer to queries by name, never by raw query text. */
  setQueries(queries: QueryDef[]): void;
  query(name: string, params: readonly unknown[]): Promise<number>;
  fetchCurrentChainPairs(): Promise<ChainPairRecord[]>;
  close(executionId?: string): Promise<void>;
}

/** poolSize should match the number of concurrent producers/clients so none
 * of them ever queues for a connection. */
export function createStore(driver: Driver, connectionString: string, poolSize: number): Store {
  switch (driver) {
    case "pg":
      return new PgStore(connectionString, poolSize);
    case "postgres":
      return new PostgresJsStore(connectionString, poolSize);
    case "mongodb":
      return new MongoStore(connectionString, poolSize);
  }
}
