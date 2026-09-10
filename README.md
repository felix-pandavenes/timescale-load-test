# timescale-swaps

Two load testers for TimescaleDB, sharing one CLI entrypoint and one
connection-pool layer:

- **`swaps`** — a synthetic write load generator. It simulates a configurable
  number of blockchain chains and trading pairs, each producing random swap
  events at an independent rate, inserting each one directly into
  TimescaleDB as soon as it's generated (one round-trip per swap, no
  queue/batching in between) so the measured write latency is exactly how
  long the database takes to return.
- **`query`** — a query load tester. A configurable number of concurrent
  clients run queries for a configurable duration, picking randomly from a
  pool of queries you define (queries can use `$chain`/`$pair` placeholders
  resolved against real values `swaps` published), and it reports per-query
  latency (avg/min/max), rows returned per query (avg/min/max, to sanity-check
  the queries actually return data), and throughput.

Both are isolated from the storage technology behind a `Store` interface
(`src/store/`) and support two Postgres drivers — [`pg`](https://node-postgres.com/)
and [`postgres`](https://github.com/porsager/postgres) (postgres.js) —
selectable per run, for comparing throughput between them. A `mongodb`
driver option exists as a placeholder (`src/store/mongodb.ts`) but isn't
implemented yet — selecting it fails loudly rather than falling back to
Postgres.

While running, each renders a live in-place terminal table of progress
(swaps: per-chain generated/error/inserted counts and write latency, with a
TOTAL row; query: per-query count/errors/latency/rows-returned, with a
TOTAL row) plus an **event-loop utilization** line (a percentage) — read it
next to the write/query latency numbers to tell apart the two ways a run
can look slow: high utilization with low DB latency means this Node
process itself is busy and can't generate or dispatch work fast enough
(the client is the bottleneck); low utilization with high DB latency means
this process is mostly idle, waiting on a slow database.

---

## Project Layout

```
timescale-swaps/
├── src/
│   ├── main.ts                # Single CLI entry: `main.ts <swaps|query> [options]`
│   ├── driver.ts               # Shared Driver type ("pg" | "postgres" | "mongodb") + isDriver()
│   ├── liveProgress.ts          # In-place terminal table renderer (shared)
│   ├── stats.ts                  # Shared LatencyStats (count/sum/min/max per named series)
│   ├── eventLoopUtilization.ts    # Shared event-loop-utilization monitor (client vs DB bottleneck)
│   ├── chainPairs.ts              # Shared chain_pairs table name/columns/ChainPair type
│   ├── store/                      # Storage-technology-agnostic pool layer (used by both apps)
│   │   ├── types.ts                  # Store interface (technology-agnostic)
│   │   ├── postgres.ts                # PostgresStore: shared base for every Postgres driver
│   │   ├── pg.ts                       # PgStore: node-postgres (extends PostgresStore)
│   │   ├── postgresjs.ts                # PostgresJsStore: postgres.js (extends PostgresStore)
│   │   ├── mongodb.ts                    # MongoStore: placeholder, not implemented yet
│   │   └── index.ts                        # Driver factory
│   ├── swaps/                      # Write load generator
│   │   ├── cli.ts                    # Arg parsing -> runSwaps
│   │   ├── app.ts                     # Per-chain generate-and-insert pipeline + live progress
│   │   ├── config.ts                   # SwapsConfig type, defaults, validation, chain/pair enumeration
│   │   ├── generator.ts                 # Per-pair random-walk swap generator
│   │   ├── schema.ts                      # `events` table/column mapping
│   │   └── types.ts                        # SwapEvent shape
│   └── query/                      # Query load tester
│       ├── cli.ts                    # Arg parsing -> runQueryLoad
│       ├── app.ts                     # Client pipeline + live progress + report
│       ├── config.ts                   # QueryConfig type, defaults, validation
│       ├── queries.ts                   # Query-pool loader/validator
│       └── placeholders.ts               # $chain/$pair sentinel resolution
├── config/
│   ├── swaps-config.json     # Default swaps config
│   ├── query-config.json     # Default query config
│   └── queries.json          # Query pool — replace with your own queries
├── db/
│   └── init/                 # SQL run once against a fresh TimescaleDB volume
├── docker-compose.yml         # Dockerized TimescaleDB
├── package.json
└── tsconfig.json
```

---

## Configuration

### `swaps` — write load generator

Config is a JSON file (default `config/swaps-config.json`):

```json
{
  "duration_sec": 0,
  "timescale_url": "postgres://swaps:swaps@localhost:5432/swaps",
  "rate_multiplier": 1,
  "driver": "pg",
  "chains": [
    { "id": "eth", "num_pairs": 100, "swaps_per_second": 5 },
    { "id": "bsc", "num_pairs": 200, "swaps_per_second": 2 }
  ]
}
```

| Field | Description |
|-------|-------------|
| `duration_sec` | How long to run. `0` means run until interrupted (Ctrl+C). |
| `timescale_url` | Postgres connection string. Falls back to `$TIMESCALE_URL`, then a local default. |
| `rate_multiplier` | Scales every chain's `swaps_per_second` by this factor — `1` (default) leaves rates unchanged, `1.3` sends 130% of each configured rate, `0.7` sends 70%. Applied once at config load, so a chain configured at `1 swaps_per_second` with `rate_multiplier: 1.3` effectively runs at `1.3 swaps_per_second`. Must be `> 0`. |
| `driver` | `"pg"`, `"postgres"`, or `"mongodb"` (placeholder, not yet implemented) — which driver to benchmark. Overridable with `--driver`. |
| `chains[].id` | Chain identifier, used as a label. Must be unique. |
| `chains[].num_pairs` | Number of pairs to simulate for this chain. Pair IDs are deterministic (a hash of `chain-index`), so the same pair identities persist across separate `swaps` runs instead of scattering data across a fresh random set every time. |
| `chains[].swaps_per_second` | The chain's *total* swap generation rate, split evenly across its pairs — e.g. 10 pairs at `swaps_per_second: 10` means 1 swap/sec per pair, not 10 each. |

One timer runs per chain, at the chain's total `swaps_per_second`, cycling
through that chain's pairs one at a time — not one timer per pair, which
would make every pair in a chain tick in lockstep (same interval, same
start time) and produce bursty, batch-like generation instead of a steady
trickle. Each generated swap is inserted immediately and independently (no
shared queue, no batching). There's no `pool_size` to configure — the DB
connection pool is sized to one connection per chain automatically, so no
chain is ever throttled waiting on another chain's in-flight insert; if the
database itself can't keep up, that shows up as higher measured write
latency (see the per-chain Avg/Min/Max(ms) columns) rather than a dropped
swap.

### `query` — query load tester

Config is a JSON file (default `config/query-config.json`):

```json
{
  "num_clients": 10,
  "duration_sec": 30,
  "queries_per_second": 0,
  "rate_multiplier": 1,
  "timescale_url": "postgres://swaps:swaps@localhost:5432/swaps",
  "driver": "pg",
  "queries_file": "config/queries.json"
}
```

| Field | Description |
|-------|-------------|
| `num_clients` | Number of concurrent virtual clients (also sizes the connection pool). Defaults to `10`. |
| `duration_sec` | How long each client keeps running queries. `0` means run until interrupted (Ctrl+C) — same semantics as `swaps`' `duration_sec`. |
| `queries_per_second` | Per-client rate limit. `0` (default): each client runs queries back-to-back as fast as possible. `>0`: each client paces itself to at most this many queries/sec (accounting for time the query itself took, so a slow query doesn't get "made up" by bursting afterward). Total system rate is roughly `num_clients * queries_per_second`. Config-file only — no CLI flag. |
| `rate_multiplier` | Scales `queries_per_second` by this factor — `1` (default) leaves it unchanged, `1.3` sends 130% of the configured rate, `0.7` sends 70%. Applied once at config load (so `queries_per_second: 5` with `rate_multiplier: 2` effectively paces at 10/sec/client). Has no effect when `queries_per_second` is `0` (unthrottled — there's no rate to scale). Must be `> 0`. |
| `timescale_url` | Postgres connection string. Falls back to `$TIMESCALE_URL`, then a local default. |
| `driver` | `"pg"`, `"postgres"`, or `"mongodb"` (placeholder, not yet implemented). Overridable with `--driver`. |
| `queries_file` | Path to the query pool (JSON array of `{ name, sql, params? }`). Overridable with `--queries`. |

Each client picks a random query from the pool on every iteration and times
how long the database takes to return it (`process.hrtime` around the query
call).

#### `$chain`/`$pair` placeholders

A query's `params` can use the string sentinels `"$chain"` and `"$pair"`
instead of a literal value. At query time they're resolved against a real
row from the `chain_pairs` table — a `(chain, pair)` reference table that
each **`swaps`** run adds its own rows to under its own execution id, rather
than truncating and repopulating the table (which would clobber a
concurrently-running `swaps` instance). Every row carries a 12h TTL;
`query` only ever reads rows belonging to currently-valid (non-expired)
executions — joined against `swaps_executions` — so it always works over
swaps data that's actually still current (see `src/chainPairs.ts` /
`db/init/003_swaps_executions.sql`). Both sentinels in the same query
resolve to the same row, so `$chain`/`$pair` are always a real, matching
combination — never an unrelated chain crossed with an unrelated pair. If a
query needs them and no current execution has published any (chain, pair)
combinations, `query` prints a warning at startup and those queries are
recorded as errors rather than crashing the run.

```json
{ "name": "Get events", "sql": "SELECT * FROM events WHERE chain = $1 AND pair = $2 ORDER BY timestamp DESC LIMIT $3;", "params": ["$chain", "$pair", 100] }
```

Run `swaps` (against the database you'll point `query` at) before `query`
if any query in your pool uses these placeholders.

Multiple `swaps` instances can run concurrently against the same database
(e.g. different configs, different chains) — each gets its own execution id
in `swaps_executions` and its own rows in `chain_pairs`, so they don't
clobber each other the way a shared truncate-then-repopulate table would.

---

## Running

```bash
# Install dependencies
npm install

# Start the dockerized TimescaleDB (schema is created from db/init/ on first boot)
docker compose up -d timescaledb

# Write load, against pg or postgres.js
npm run swaps:pg
npm run swaps:postgres

# Query load, against pg or postgres.js
npm run query:pg
npm run query:postgres

# Everything goes through one entrypoint: main.ts <swaps|query> [options]
npx tsx src/main.ts swaps --config path/to/config.json --driver postgres
npx tsx src/main.ts query --clients 20 --queries path/to/queries.json

# Or build once and run the compiled output
npm run build
node dist/main.js swaps --driver pg
node dist/main.js query --driver postgres
```
