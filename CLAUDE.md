# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`timescale-swaps` is two load testers for TimescaleDB, written in
TypeScript/Node, sharing one CLI entrypoint and one connection-pool layer:

- **`swaps`** (write load) — simulates a configurable number of blockchain
  chains and trading pairs, each producing random swap events at an
  independent rate, inserting each one directly into a dockerized
  TimescaleDB as soon as it's generated (one round-trip per swap — no
  queue or batching in between).
- **`query`** (query load) — a configurable number of concurrent clients run
  queries for a configurable duration, picking randomly from a user-defined
  pool of queries (which can use `$chain`/`$pair` placeholders resolved
  against real values `swaps` published — see below), measuring per-query
  latency and throughput.

Both support two Postgres drivers — `pg` (node-postgres) and `postgres`
(postgres.js) — selectable per run via `--driver`, for comparing throughput
between them.

This was originally a Go program (write-only); it was fully ported to
TypeScript, the Go sources were removed, and the query tester was added
after that (originally called `read`, renamed to `query` afterward — if you
find a stray "read"/"reads" reference anywhere, it's a rename miss). There
is no Go code left in this repo.

## Commands

```bash
npm install                                        # install dependencies
npm run build                                      # tsc -> dist/

npm run swaps:pg                                   # tsx src/main.ts swaps --driver pg
npm run swaps:postgres                             # tsx src/main.ts swaps --driver postgres
npm run query:pg                                   # tsx src/main.ts query --driver pg
npm run query:postgres                              # tsx src/main.ts query --driver postgres

npx tsx src/main.ts swaps --config path/to/config.json --driver postgres
npx tsx src/main.ts query --clients 20 --queries path/to/queries.json

node dist/main.js swaps                            # run built output
node dist/main.js query

docker compose up -d timescaledb                   # start TimescaleDB (schema from db/init/ on first boot)
```

There is no test suite or linter configured in this repo yet.

## Architecture

Single Node/TypeScript process per invocation, no other services besides the
dockerized TimescaleDB. Both apps share `src/driver.ts` (the `Driver` union
type), `src/liveProgress.ts` (the terminal renderer), `src/stats.ts` (the
`LatencyStats` latency tracker), `src/eventLoopUtilization.ts`
(event-loop-utilization monitoring), and `src/store/` (the connection-pool
layer) — everything else is namespaced per app.

- `src/main.ts` — the only CLI entrypoint. Takes the app name as the first
  positional arg (`swaps` or `query`) and dispatches the rest of `argv` to
  that app's `cli.ts`. Unknown/missing mode prints usage and exits 1.
- `src/store/` — storage-technology-agnostic: neither app (`swaps`/`query`)
  imports anything Postgres- or Mongo-specific, only `Store` and
  `createStore`.
  - `types.ts` — `Store` interface (`connect`/`insertBatch`/`insertOne`/
    `query`/`fetchAll`/`close`), generic over table/columns/rows. `insertOne`
    (used by `swaps` — see `insertSwap` in `app.ts` below) exists as its own
    interface method rather than making every call site wrap a single row
    in an array itself.
  - `postgres.ts` — `PostgresStore`: an abstract class holding everything
    generic about talking to Postgres, shared by both Postgres drivers
    instead of duplicated in each. Implements `insertBatch` (chunked via
    `chunkForParamLimit`, which lives here since the 65535-bind-parameter
    limit is a Postgres wire-protocol detail, not a generic `Store`
    concept), `insertOne` (`insertBatch(table, columns, [row])`), and
    `query`/`fetchAll` (both just call an abstract `execute()` and pick one
    half of its `{ rowCount, rows }` result). Subclasses only implement
    `connect`, `close`, `execute`, and `insertChunk` (one already-under-the-
    param-limit chunk of rows).
  - `pg.ts` — `PgStore extends PostgresStore`; `insertChunk` builds a manual
    multi-row parameterized INSERT, `execute` is `pool.query(sql, params)`.
  - `postgresjs.ts` — `PostgresJsStore extends PostgresStore`; `insertChunk`
    uses postgres.js's `sql(rows)` bulk-insert helper, `execute` uses
    `sql.unsafe` (query text is only known at runtime for the query side,
    so a tagged template won't work).
  - `mongodb.ts` — `MongoStore implements Store` directly (not
    `PostgresStore` — Mongo isn't Postgres-flavored, so there's nothing to
    share with it). Placeholder: every method throws `"not implemented
    yet"` rather than silently no-op'ing, so an accidental `--driver
    mongodb` run fails loudly instead of pretending to work. Not filled in
    yet.
  - `index.ts` — `createStore(driver, connectionString, poolSize)` — `query`
    passes `num_clients` (a client never queuing for a pooled connection
    matters there because that queueing would otherwise show up as query
    latency); `swaps` passes `cfg.chains.length` (see `app.ts` below) rather
    than a configurable size, so no chain is ever throttled waiting on
    another chain's in-flight insert.
  - None of the three implementations create schema — that's owned by
    `db/init/`, applied once by TimescaleDB on first boot against an empty
    data volume.
- `src/stats.ts` — `LatencyStats`: tracks count/sum/min/max of a numeric
  sample per named series, unit-agnostic (the field names are just
  `avg`/`min`/`max`, not `avgMs` etc.) — `swaps` keys one instance by chain
  id for write latency in ms (see `app.ts` below); `query` uses two
  instances both keyed by query name, one for latency in ms and one for
  rows returned. O(1) memory per record — no raw samples are kept and there
  are no percentiles, deliberately, since retaining per-sample values would
  grow unbounded over a long/high-throughput run. `live(name)`/`liveTotal()`
  back both the live-progress view and the final report.
- `src/eventLoopUtilization.ts` — `createEventLoopUtilization()` wraps
  `perf_hooks.performance.eventLoopUtilization()` to answer the question
  `LatencyStats` alone can't: is a slow run the *database's* fault or *this
  process's*? `start()` captures a baseline reading; `snapshot()` diffs the
  current reading against that baseline (`performance.eventLoopUtilization(baseline)`)
  to get `{ utilizationPct, activeMs, idleMs }` — cumulative since
  `start()`, same non-windowed philosophy as `LatencyStats`, not a rolling
  window. Both apps `start()` it right after connecting, `stop()` it right
  after `progress.stopAndWait()` (which just clears the baseline —
  there's no background timer/observer to actually tear down, unlike the
  histogram-based approach this replaced), and feed `snapshot()` into
  their live-progress renderer as an "Event loop utilization: N%" line
  next to the latency table. High utilization with low write/query latency
  means this process itself is busy and can't generate/dispatch work fast
  enough (CPU-bound work, GC pauses, too many timers) — the client is the
  bottleneck. Low utilization with high write/query latency means this
  process is mostly idle, waiting on a slow database.
- `src/chainPairs.ts` — `CHAIN_PAIRS_TABLE`/`CHAIN_PAIRS_COLUMNS`/`ChainPair`
  and `EXECUTIONS_TABLE`/`EXECUTIONS_COLUMNS`: shared knowledge of the
  `chain_pairs`/`swaps_executions` reference tables (see Database below),
  which `swaps` writes to and `query` reads from.

### `src/swaps/` — write load generator

- `cli.ts` — parses `--config`/`--driver`, loads config via
  `loadSwapsConfig`, calls `runSwaps(cfg)`.
- `config.ts` — `SwapsConfig` (duration, timescale URL, `rate_multiplier`,
  driver, chains) loaded from JSON (snake_case on disk, camelCase in code),
  defaults applied and validated before use. No pool-size field —
  `app.ts` sizes the DB connection pool to `chains.length` directly instead
  of exposing it as a config knob. `rate_multiplier` (must be `> 0`, defaults to `1`)
  is applied once here, during `applyDefaults` — each
  `ChainConfig.swapsPerSecond` is already `raw.swaps_per_second *
  rateMultiplier` by the time anything else reads it, so `app.ts` doesn't
  need to know the multiplier exists. `pairCount()` sums pairs across
  chains for display; `pairId(chain, index)` is the single source of truth
  for pair naming — a SHA-256 hash of `${chain}-${index}` (base64url,
  deterministic on purpose: the same (chain, index) always hashes to the
  same id across separate runs, so the database accumulates real history
  under a stable set of pair identities instead of starting over every
  run) — used by both the generator timers below and `allChainPairs()`, so
  they can't drift apart; `allChainPairs(cfg)` enumerates every
  `(chain, pair)` combination the config simulates.
- `app.ts` — the pipeline, in `runSwaps`:
  - Each run generates its own `execution_id` (`randomUUID()`) so
    concurrent `swaps` instances don't collide. Right after
    `store.connect()`: `cleanupExpiredExecutions` deletes rows past their
    `expires_at` from both `chain_pairs` and `swaps_executions` (lazy TTL —
    there's no background job doing this); `registerExecution` inserts this
    run's id into `swaps_executions`; `publishChainPairs` bulk-inserts
    `allChainPairs(cfg)` into `chain_pairs` tagged with this `execution_id`
    (no truncation — that's what let concurrent runs collide before). This
    is what lets `query` resolve `$chain`/`$pair` placeholders against real
    values from whichever `swaps` run(s) are/were active in the last 12h
    (`EXECUTION_TTL_MS`). On a clean stop (duration elapsed or SIGINT,
    after every started insert has finished), `deregisterExecution` deletes
    this run's own row from `swaps_executions` — the FK cascade takes its
    `chain_pairs` rows with it — so a finished run stops looking "current"
    to `query` immediately instead of lingering until its TTL expires or a
    future `swaps` run's `cleanupExpiredExecutions` happens to catch it. A
    killed/crashed process (SIGKILL, crash) skips this and still falls back
    to the TTL — there's no way to run cleanup code on a process that
    doesn't get to exit gracefully.
  - One `setInterval` timer **per chain** (not per pair) ticks at the
    chain's total `swaps_per_second` and round-robins over that chain's
    `PairState`s (one per pair, advancing an index modulo `numPairs` each
    tick). This used to be one timer per `(chain, pair)`, each computed at
    `swaps_per_second / numPairs` — every pair in a chain got the exact
    same interval *and* the exact same start time, so they fired in
    lockstep: one swap per pair, all at once, every period, instead of a
    steady trickle (visible as event timestamps clustering into bursts
    instead of spreading evenly across seconds). A single per-chain timer
    produces the same average per-pair rate without that synchronization,
    and cuts the timer count from (sum of `num_pairs` across chains) down
    to (number of chains) — relevant since some configs have thousands of
    pairs per chain.
  - Every tick generates one `SwapEvent` and calls `insertSwap` for it
    directly — no queue, no batching in between. There used to be a shared
    bounded `SwapQueue` between generation and insertion (with `num_consumers`
    worker loops draining it, either batching swaps together or inserting
    them one at a time), whose "queue full → drop" signal was meant to
    detect a client that couldn't keep up. That's now redundant with
    `src/eventLoopUtilization.ts` (a more direct signal for the same thing) and made
    "how long does the database take" harder to read (a batch's latency
    isn't any one swap's latency; a queued swap's latency isn't purely
    insert time). Removing it makes each chain's Avg/Min/Max(ms) mean
    exactly one thing: one INSERT's round-trip time.
  - `insertSwap(store, chainId, swap, stats, writeStats)` times the INSERT
    with `process.hrtime.bigint()`, increments `ChainStats.inserted` and
    records the latency into a `LatencyStats` (`src/stats.ts`) keyed by
    chain id on success, or increments `ChainStats.errors` on failure (an
    insert error no longer crashes the process — this is called detached
    from the generator's `setInterval` tick, so nothing else would catch
    the rejection). `setInterval` doesn't await its callback, so a chain
    whose insert is slower than its own tick interval will have more than
    one insert in flight at once — `inFlight` (a `Set<Promise<void>>` in
    `runSwaps`) is what shutdown awaits (`Promise.all(inFlight)`) to make
    sure every started insert gets to finish or fail before the store
    closes. The DB pool (`createStore(cfg.driver, cfg.timescaleUrl,
    cfg.chains.length)` — one connection per chain, computed in `runSwaps`,
    not a config field) is what actually caps concurrency against the
    database; a fixed/shared pool smaller than `chains.length` would let
    whichever chains fire first starve the rest of a connection, polluting
    their latency numbers with wait-for-connection time instead of pure
    insert time.
  - Shutdown: either `duration_sec` elapses (`setTimeout`) or SIGINT is
    caught — both stop the generator timers, then `inFlight` is drained.
    The live view's last frame (from `progress.stopAndWait()`) already
    shows the final per-chain table with its TOTAL row, so the one-off
    lines printed after that (`"Done. Inserted N swaps in Ts."`, plus a
    `"Dropped N swaps (failed to insert)."` line — only printed when
    errors `> 0`, to stay quiet on a clean run) deliberately don't reprint
    it — same principle as `query`'s final report (see below).
  - Live stats (`LiveSwapStats`, `ChainStats`) are plain mutable
    objects/numbers, not atomics — safe because Node is single-threaded and
    nothing awaits between a stat read and its update.
  - `chainColumnWidth`/`chainTableWidth`/`formatChainHeader`/
    `formatChainRow` size the "Chain" column to the longest chain id (or
    "TOTAL"/the header) rather than a fixed width, so a long chain id can't
    push the rest of the row out of alignment.
- `generator.ts` — `PairState`: per-(chain,pair) random-walk state
  (price/liquidity move as a random walk on each `next()` call), mirrors the
  original Go generator's math exactly.
- `schema.ts` — `EVENT_TABLE`/`EVENT_COLUMNS`/`toEventRow`: the mapping from
  `SwapEvent` (see `types.ts`) to a row matching the `events` table.

### `src/query/` — query load tester

- `cli.ts` — parses `--config`/`--driver`/`--queries`/`--clients`, loads
  config via `loadQueryConfig` and the query pool via `loadQueryPool`, calls
  `runQueryLoad(cfg, queries)`.
- `config.ts` — `QueryConfig` (num clients, `duration_sec` — `0` = run until
  interrupted, same semantics as `swaps`, `queries_per_second` — a
  per-client rate limit, `0` = unthrottled, config-file only, no CLI flag —
  `rate_multiplier`, timescale URL, driver, queries file path), same
  JSON-with-defaults pattern as `swaps`. `rate_multiplier` (must be `> 0`,
  defaults to `1`) is applied once here, same as `swaps`' —
  `queriesPerSecond` is already `raw.queries_per_second *
  rateMultiplier` by the time `app.ts` reads it (multiplying `0` stays
  `0`, so it's a no-op when unthrottled).
- `queries.ts` — `QueryDef` (`{ name, sql, params? }`) and `loadQueryPool`,
  validating a non-empty JSON array with unique names.
- `placeholders.ts` — `CHAIN_PLACEHOLDER`/`PAIR_PLACEHOLDER` (the literal
  strings `"$chain"`/`"$pair"`), `needsChainPair`, and `resolveParams`:
  substitutes those sentinels in a query's `params` with a single randomly
  picked `chain_pairs` row (both sentinels in one query resolve to the same
  row, so they're always a real matching combination). Throws if a query
  needs them and the pool is empty — `runClient` already catches/records
  query errors, so this surfaces as a normal per-query error, not a crash.
- `app.ts` — `runQueryLoad`: right after `store.connect()`, fetches
  `chain_pairs` joined against `swaps_executions` — `WHERE e.expires_at >=
  now()` — via `store.fetchAll` once (not on the timed path), so it only
  ever works over (chain, pair) combinations from currently-valid `swaps`
  executions rather than trusting `chain_pairs`' content on its own (which
  could otherwise still hold rows from a run that expired since the last
  time some `swaps` instance happened to run `cleanupExpiredExecutions`).
  Warns if that comes back empty while some query needs it. Then spins up
  `num_clients` concurrent client loops (`runClient`), each looping `while
  (!isStopped())` — a random query from the pool each time, params run
  through `resolveParams` — until either `duration_sec` elapses
  (`setTimeout`) or SIGINT is caught, both of which flip the same `stopped`
  flag/`status` message (`"Duration reached — draining"` vs `"Interrupted —
  draining"`), mirroring `swaps`' `stopGenerators` pattern exactly. If
  `queries_per_second > 0`, each client sleeps between queries for
  whatever's left of `1000 / queries_per_second` ms after subtracting the
  time the query itself took (never a negative sleep, so a slow query just
  eats into the client's own budget instead of the next query bursting to
  catch up). Each query is timed with `process.hrtime.bigint()` around the
  `Store.query` call. `Store.query` also returns the row count, which is
  recorded into a second `LatencyStats` instance (`rowStats`) — the class
  is unit-agnostic, so the same count/sum/min/max machinery backs both
  ms-latency and rows-returned. `formatRow(name, latencyLiveStats,
  rowsLiveStats, nameWidth)` merges one query's latency and row-count stats
  into a single report row (`Query | Count | Errors | Avg/Min/Max(ms) |
  Avg/Min/Max Rows`) and is shared by the live view and the final report,
  so they can't drift out of sync with each other. `nameColumnWidth` sizes
  the "Query" column to the longest query name (or "TOTAL"/the header)
  rather than a fixed width, for the same reason as `swaps`'
  `chainColumnWidth`. Rows are only recorded on success (a failed query
  contributes to `stats`' error count but not to `rowStats`). The live
  view's last frame (from `progress.stopAndWait()`) already shows the final
  table with its TOTAL row, so `printFinalReport` deliberately doesn't
  reprint it — it only prints an "Interrupted" note (when `status`
  indicates SIGINT, not when the duration simply elapsed), the
  elapsed/throughput line, and (only when `total.errors > 0`, to stay quiet
  on a clean run) a `"Dropped N queries..."` line — `query` has no bounded
  queue to drop from like `swaps` does, so "dropped" here means failed
  queries that never completed, i.e. `stats`' error count.

When changing the swaps generate-and-insert pipeline, keep in mind each
chain's timer fires independently of whether its previous insert has
finished (`setInterval` doesn't await its callback) — `ChainStats` and
`inFlight` are what let multiple concurrent inserts per chain, and a clean
shutdown that waits for all of them, coexist correctly.

## Database

`docker-compose.yml` defines a `timescaledb` service
(`timescale/timescaledb:latest-pg16`) with a named volume and a healthcheck.
`db/init/*.sql` files are mounted to `/docker-entrypoint-initdb.d` and run
**once each, in filename order**, only against a fresh (empty) data volume
— adding/editing one after the container has already initialized requires
either `docker compose down -v` (drops the volume) or applying it by hand
(`docker exec -i <container> psql -U swaps -d swaps < db/init/00N_*.sql`) to
take effect on an existing database.

- `001_init.sql` creates the `events` hypertable (with compression and
  continuous aggregates for candles) that `src/swaps/` inserts into and
  `src/query/`'s query pool is expected to query.
- `002_chain_pairs.sql` — superseded by `003_swaps_executions.sql` below
  (which drops and recreates `chain_pairs`); kept only as history of how
  the table got to its current shape.
- `003_swaps_executions.sql` creates `swaps_executions` (`id` — a UUID from
  `crypto.randomUUID()`, `started_at`, `expires_at`) and recreates
  `chain_pairs` keyed by `(execution_id, chain, pair)` with its own
  `expires_at`, `execution_id` referencing `swaps_executions.id` with `ON
  DELETE CASCADE`. This is what lets multiple `swaps` instances run
  concurrently: each run gets its own execution id and adds its own
  `chain_pairs` rows instead of truncating the table (which used to wipe
  out whatever a concurrently-running instance had just written). Neither
  table is cleaned up by a background job (no pg_cron in this image) —
  every `swaps` run deletes rows past their `expires_at` from both tables
  before adding its own (`cleanupExpiredExecutions` in `src/swaps/app.ts`),
  and `query` only ever reads `chain_pairs` joined against
  non-expired `swaps_executions` rows (see `src/query/app.ts` above), so a
  `swaps` run that already expired can't leak stale chain/pairs into a
  `query` run even if no newer `swaps` run has cleaned it up yet. TTL is 12h
  (`EXECUTION_TTL_MS` in `src/swaps/app.ts`).

Note: `db/init/001_init.sql` previously included an `add_tiering_policy`
call — that function only exists on Timescale Cloud (managed
object-storage tiering), not in the self-hosted `timescale/timescaledb`
image this repo runs, so it's commented out.

Default credentials (from `docker-compose.yml` / `config/*.json`):
`postgres://swaps:swaps@localhost:5432/swaps`.
