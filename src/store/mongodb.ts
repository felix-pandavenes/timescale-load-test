import { MongoClient, Collection } from "mongodb";
import type { Store } from "./index.js";
import type { ChainPair, ChainPairRecord, QueryDef, SwapEvent } from "../domain.js";

const EVENTS_PAIR_COLLECTION = "events_pair_buckets";

interface EventBucketId {
  exchange: string;
  pair: string;
  token: string;
  tokenRef: string;
}

/** A bucket document: up to 100 swaps for one pair, grouped together so a
 * high-frequency pair doesn't get one document per swap. */
interface EventBucket {
  id: EventBucketId;
  tag?: string;
  count: number;
  firstTime: Date;
  firstBlock: number;
  lastTime: Date;
  lastBlock: number;
  content: { event: SwapEvent }[];
}

/** MongoDB-backed Store. Doesn't extend PostgresStore: Mongo isn't
 * Postgres-flavored, so there's no bind-param chunking or SQL text to share
 * with it — this is a direct `Store` implementation, same as the Postgres
 * ones are from the caller's point of view. Swap insertion is implemented
 * (bucketed into per-pair documents, capped at 100 events per bucket);
 * `init`/`query`/`fetchCurrentChainPairs` (chain/pair + execution tracking)
 * are not implemented yet — every method throws until filled in, rather
 * than silently no-op'ing, so an accidental `--driver mongodb` run fails
 * loudly instead of pretending to work. */
export class MongoStore implements Store {
  private readonly client: MongoClient;
  private readonly eventsPairCollection: Collection<EventBucket>;
  private queriesByName = new Map<string, QueryDef>();

  constructor(connectionString: string, maxPoolSize: number) {
    this.client = new MongoClient(connectionString, { maxPoolSize });
    this.eventsPairCollection = this.client.db().collection<EventBucket>(EVENTS_PAIR_COLLECTION);
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async init(pairs: ChainPair[], executionId: string, expiresAt: Date): Promise<void> {
    await this.connect();
    throw new Error("MongoStore.init: not implemented yet");
  }

  async insertSwap(swap: SwapEvent): Promise<void> {
    await this.insertRow(swap);
  }

  setQueries(queries: QueryDef[]): void {
    this.queriesByName = new Map(queries.map((q) => [q.name, q]));
  }

  async query(name: string, params: readonly unknown[]): Promise<number> {
    throw new Error("MongoStore.query: not implemented yet");
  }

  async fetchCurrentChainPairs(): Promise<ChainPairRecord[]> {
    throw new Error("MongoStore.fetchCurrentChainPairs: not implemented yet");
  }

  async close(executionId?: string): Promise<void> {
    await this.client.close();
  }

  /** Upserts a single swap into its pair's current bucket document (a
   * bucket holds up to 100 events before a new one is started), rather than
   * inserting one document per swap. */
  private async insertRow(event: SwapEvent): Promise<void> {
    try {
      const bucketId = {
        exchange: "echaange-1",
        pair: event.pair,
        token: `${event.pair}-token`,
        tokenRef: `${event.pair}-tokenRef`,
      };

      const eventDate = new Date(event.timestamp * 1000);
      const filter = {
        $and: [
          { id: bucketId },
          { tag: { $exists: false } },
          {
            $or: [{ count: { $lt: 100 } }, { lastTime: eventDate }],
          },
        ],
      };

      const update = {
        $push: {
          content: { event },
        },
        $inc: { count: 1 },
        $set: { lastTime: eventDate, lastBlock: event.blockNumber },
        $setOnInsert: { id: bucketId, firstTime: eventDate, firstBlock: event.blockNumber },
      };

      const options = { upsert: true };

      await this.eventsPairCollection.updateOne(filter, update, options);
    } catch (err) {
      const error = err as Error;
      console.log(`MongoStore.insertRow(${event.pair}) ERROR writing swap ${JSON.stringify(event)}: ${error.message}`);
    }
  }
}
