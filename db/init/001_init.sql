-- ############################################################
-- Phase 1: Events 
-- ############################################################

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE events (
    chain           TEXT NOT NULL,
    pair            TEXT NOT NULL,
    id              TEXT NOT NULL,          -- tx id de blockchain
    block_number    BIGINT NOT NULL,
    log_index       INT NOT NULL,
    "timestamp"     TIMESTAMPTZ NOT NULL,
    type            TEXT NOT NULL,
    amount_token    NUMERIC(76,18) NOT NULL,
    amount_eth      NUMERIC(76,18) NOT NULL,
    amount_ref      NUMERIC(76,18) NOT NULL,
    price           NUMERIC(76,18),
    price_eth       NUMERIC(76,18),
    amount_usd      NUMERIC(76,18) NOT NULL,
    event_liquidity NUMERIC(76,18),
    amount_lp_token NUMERIC(76,18),
    maker           TEXT NOT NULL,
    bot             BOOLEAN NOT NULL DEFAULT false,
    bot_address     TEXT,
    scamwick        BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (chain, pair, block_number, log_index, "timestamp")
);

SELECT create_hypertable('events', by_range('timestamp'));
SELECT set_chunk_time_interval('events', INTERVAL '1 day');

-- Índices (R5: chain como primera columna)
CREATE INDEX idx_events_chain_pair_ts       ON events (chain, pair, "timestamp" DESC);
CREATE INDEX idx_events_chain_maker_pair_ts ON events (chain, maker, pair, "timestamp" DESC);
-- TBD: validar orden de columnas del índice de maker con EXPLAIN (Q3).

-- Compresión
ALTER TABLE events SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'chain, pair',
    timescaledb.compress_orderby   = 'timestamp DESC, block_number DESC, log_index DESC'
);
SELECT add_compression_policy('events', INTERVAL '7 days');

-- Cold storage (R9): tiered storage de Timescale Cloud
-- SELECT add_tiering_policy('events', INTERVAL '1 year');

-- CHECK constraints opcionales de plausibilidad (R11) — segundo tripwire.
-- Descomentar si se decide aplicarlos también en BD además de en el borde:
-- ALTER TABLE events ADD CONSTRAINT chk_amount_usd_plausible CHECK (amount_usd >= 0 AND amount_usd < 1e15);
-- ALTER TABLE events ADD CONSTRAINT chk_price_plausible CHECK (price IS NULL OR (price >= 0 AND price < 1e30));

CREATE TABLE events_quarantine (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    quarantined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reason      TEXT NOT NULL,            -- 'plausibility' | 'overflow_22003' | ...
    raw_event   JSONB NOT NULL            -- evento crudo tal como llegó
);
CREATE INDEX idx_quarantine_at ON events_quarantine (quarantined_at DESC);


-- ############################################################
-- Phase 2: Candles
-- ############################################################

-- ============================================================
-- candles_1m — desde events (filtro R1: solo buy/sell, sin scamwick)
-- ============================================================
CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 minute', "timestamp") AS bucket,
    chain, pair,
    first(price, "timestamp")     AS open_usd,
    max(price)                    AS high_usd,
    min(price)                    AS low_usd,
    last(price, "timestamp")      AS close_usd,
    sum(amount_usd)               AS volume_usd,
    first(price_eth, "timestamp") AS open_native,
    max(price_eth)                AS high_native,
    min(price_eth)                AS low_native,
    last(price_eth, "timestamp")  AS close_native,
    sum(amount_eth)               AS volume_native,
    count(*) FILTER (WHERE type = 'buy')  AS buys_number,
    count(*) FILTER (WHERE type = 'sell') AS sells_number,
    sum(amount_usd) FILTER (WHERE type = 'buy')  AS buys_volume,
    sum(amount_usd) FILTER (WHERE type = 'sell') AS sells_volume,
    min(block_number) AS first_block,
    max(block_number) AS last_block
FROM events
WHERE type IN ('buy', 'sell')
  AND NOT scamwick
GROUP BY bucket, chain, pair
WITH NO DATA;
-- Fallback sin toolkit:
--   first(x, ts) -> (array_agg(x ORDER BY ts ASC))[1]
--   last(x, ts)  -> (array_agg(x ORDER BY ts DESC))[1]

CREATE INDEX idx_candles_1m_pair_bucket ON candles_1m (chain, pair, bucket DESC);

-- ============================================================
-- candles_1h — desde candles_1m
-- ============================================================
CREATE MATERIALIZED VIEW candles_1h
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', bucket) AS bucket,
    chain, pair,
    first(open_usd, bucket)     AS open_usd,
    max(high_usd)               AS high_usd,
    min(low_usd)                AS low_usd,
    last(close_usd, bucket)     AS close_usd,
    sum(volume_usd)             AS volume_usd,
    first(open_native, bucket)  AS open_native,
    max(high_native)            AS high_native,
    min(low_native)             AS low_native,
    last(close_native, bucket)  AS close_native,
    sum(volume_native)          AS volume_native,
    sum(buys_number)  AS buys_number,
    sum(sells_number) AS sells_number,
    sum(buys_volume)  AS buys_volume,
    sum(sells_volume) AS sells_volume,
    min(first_block) AS first_block,
    max(last_block)  AS last_block
FROM candles_1m
GROUP BY 1, chain, pair
WITH NO DATA;

CREATE INDEX idx_candles_1h_pair_bucket ON candles_1h (chain, pair, bucket DESC);

-- ============================================================
-- candles_1d — desde candles_1h
-- ============================================================
CREATE MATERIALIZED VIEW candles_1d
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', bucket) AS bucket,
    chain, pair,
    first(open_usd, bucket)     AS open_usd,
    max(high_usd)               AS high_usd,
    min(low_usd)                AS low_usd,
    last(close_usd, bucket)     AS close_usd,
    sum(volume_usd)             AS volume_usd,
    first(open_native, bucket)  AS open_native,
    max(high_native)            AS high_native,
    min(low_native)             AS low_native,
    last(close_native, bucket)  AS close_native,
    sum(volume_native)          AS volume_native,
    sum(buys_number)  AS buys_number,
    sum(sells_number) AS sells_number,
    sum(buys_volume)  AS buys_volume,
    sum(sells_volume) AS sells_volume,
    min(first_block) AS first_block,
    max(last_block)  AS last_block
FROM candles_1h
GROUP BY 1, chain, pair
WITH NO DATA;

CREATE INDEX idx_candles_1d_pair_bucket ON candles_1d (chain, pair, bucket DESC);

-- ============================================================
-- candles_1s — desde events, ventana viva (decidido §3.3.1)
-- ============================================================
CREATE MATERIALIZED VIEW candles_1s
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 second', "timestamp") AS bucket,
    chain, pair,
    first(price, "timestamp")     AS open_usd,
    max(price)                    AS high_usd,
    min(price)                    AS low_usd,
    last(price, "timestamp")      AS close_usd,
    sum(amount_usd)               AS volume_usd,
    first(price_eth, "timestamp") AS open_native,
    max(price_eth)                AS high_native,
    min(price_eth)                AS low_native,
    last(price_eth, "timestamp")  AS close_native,
    sum(amount_eth)               AS volume_native,
    count(*) FILTER (WHERE type = 'buy')  AS buys_number,
    count(*) FILTER (WHERE type = 'sell') AS sells_number
FROM events
WHERE type IN ('buy', 'sell')
  AND NOT scamwick
GROUP BY bucket, chain, pair
WITH NO DATA;

CREATE INDEX idx_candles_1s_pair_bucket ON candles_1s (chain, pair, bucket DESC);

-- ============================================================
-- Backfill inicial (una vez, por tramos en producción)
-- ============================================================
-- CALL refresh_continuous_aggregate('candles_1m', '<desde>', '<hasta>');
-- CALL refresh_continuous_aggregate('candles_1h', '<desde>', '<hasta>');
-- CALL refresh_continuous_aggregate('candles_1d', '<desde>', '<hasta>');
-- (candles_1s no se backfillea: solo ventana viva)

-- ============================================================
-- Policies
-- ============================================================
SELECT add_continuous_aggregate_policy('candles_1m',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');   -- TBD

SELECT add_continuous_aggregate_policy('candles_1h',
    start_offset => INTERVAL '3 days',
    end_offset   => INTERVAL '1 hour',
    schedule_interval => INTERVAL '5 minutes');  -- TBD

SELECT add_continuous_aggregate_policy('candles_1d',
    start_offset => INTERVAL '7 days',
    end_offset   => INTERVAL '1 day',
    schedule_interval => INTERVAL '30 minutes'); -- TBD

SELECT add_continuous_aggregate_policy('candles_1s',
    start_offset => INTERVAL '2 hours',
    end_offset   => INTERVAL '30 seconds',
    schedule_interval => INTERVAL '30 seconds'); -- TBD (materialización moderada, §3.3.1)

SELECT add_retention_policy('candles_1s', INTERVAL '48 hours'); -- TBD 24-48h

-- Compresión de las tablas de materialización (pendiente §4.2: definir compress_after)
-- ALTER MATERIALIZED VIEW candles_1m SET (timescaledb.compress,
--     timescaledb.compress_segmentby = 'chain, pair');
-- SELECT add_compression_policy('candles_1m', INTERVAL '7 days');  -- TBD
-- (ídem 1h/1d)

-- Tablas legacy (R2, R10): volcado ÚNICO desde Mongo, en numeric. Nunca se recalculan.
CREATE TABLE candles_1m_legacy (
    chain TEXT NOT NULL,
    pair  TEXT NOT NULL,
    bucket TIMESTAMPTZ NOT NULL,
    open_usd NUMERIC, high_usd NUMERIC, low_usd NUMERIC, close_usd NUMERIC, volume_usd NUMERIC,
    open_native NUMERIC, high_native NUMERIC, low_native NUMERIC, close_native NUMERIC, volume_native NUMERIC,
    buys_number INT, sells_number INT, buys_volume NUMERIC, sells_volume NUMERIC,
    PRIMARY KEY (chain, pair, bucket)
);

CREATE TABLE candles_1h_legacy (LIKE candles_1m_legacy INCLUDING ALL);
CREATE TABLE candles_1d_legacy (LIKE candles_1m_legacy INCLUDING ALL);
-- Se rellenan una única vez en la migración (resample del legacy 1m).

-- Cutoff por par
CREATE TABLE pair_events_boundary (
    chain TEXT NOT NULL,
    pair  TEXT NOT NULL,
    events_start_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (chain, pair)
);

-- Vista unificada 1m (R4: LEFT JOIN + COALESCE para pares nuevos)
CREATE VIEW candles_1m_unified AS
SELECT c.bucket, c.chain, c.pair,
       c.open_usd, c.high_usd, c.low_usd, c.close_usd, c.volume_usd,
       c.open_native, c.high_native, c.low_native, c.close_native, c.volume_native,
       c.buys_number, c.sells_number, c.buys_volume, c.sells_volume,
       c.first_block, c.last_block
FROM candles_1m c
LEFT JOIN pair_events_boundary b
  ON b.chain = c.chain AND b.pair = c.pair
WHERE c.bucket >= COALESCE(b.events_start_at, '-infinity')
UNION ALL
SELECT l.bucket, l.chain, l.pair,
       l.open_usd, l.high_usd, l.low_usd, l.close_usd, l.volume_usd,
       l.open_native, l.high_native, l.low_native, l.close_native, l.volume_native,
       l.buys_number, l.sells_number, l.buys_volume, l.sells_volume,
       NULL::bigint AS first_block, NULL::bigint AS last_block
FROM candles_1m_legacy l
JOIN pair_events_boundary b
  ON b.chain = l.chain AND b.pair = l.pair AND l.bucket < b.events_start_at;

-- Vistas unificadas 1h y 1d: idénticas sustituyendo candles_1m -> candles_1h/candles_1d
-- y candles_1m_legacy -> candles_1h_legacy/candles_1d_legacy.
CREATE VIEW candles_1h_unified AS
SELECT c.bucket, c.chain, c.pair,
       c.open_usd, c.high_usd, c.low_usd, c.close_usd, c.volume_usd,
       c.open_native, c.high_native, c.low_native, c.close_native, c.volume_native,
       c.buys_number, c.sells_number, c.buys_volume, c.sells_volume,
       c.first_block, c.last_block
FROM candles_1h c
LEFT JOIN pair_events_boundary b
  ON b.chain = c.chain AND b.pair = c.pair
WHERE c.bucket >= COALESCE(b.events_start_at, '-infinity')
UNION ALL
SELECT l.bucket, l.chain, l.pair,
       l.open_usd, l.high_usd, l.low_usd, l.close_usd, l.volume_usd,
       l.open_native, l.high_native, l.low_native, l.close_native, l.volume_native,
       l.buys_number, l.sells_number, l.buys_volume, l.sells_volume,
       NULL::bigint, NULL::bigint
FROM candles_1h_legacy l
JOIN pair_events_boundary b
  ON b.chain = l.chain AND b.pair = l.pair AND l.bucket < b.events_start_at;

CREATE VIEW candles_1d_unified AS
SELECT c.bucket, c.chain, c.pair,
       c.open_usd, c.high_usd, c.low_usd, c.close_usd, c.volume_usd,
       c.open_native, c.high_native, c.low_native, c.close_native, c.volume_native,
       c.buys_number, c.sells_number, c.buys_volume, c.sells_volume,
       c.first_block, c.last_block
FROM candles_1d c
LEFT JOIN pair_events_boundary b
  ON b.chain = c.chain AND b.pair = c.pair
WHERE c.bucket >= COALESCE(b.events_start_at, '-infinity')
UNION ALL
SELECT l.bucket, l.chain, l.pair,
       l.open_usd, l.high_usd, l.low_usd, l.close_usd, l.volume_usd,
       l.open_native, l.high_native, l.low_native, l.close_native, l.volume_native,
       l.buys_number, l.sells_number, l.buys_volume, l.sells_volume,
       NULL::bigint, NULL::bigint
FROM candles_1d_legacy l
JOIN pair_events_boundary b
  ON b.chain = l.chain AND b.pair = l.pair AND l.bucket < b.events_start_at;


-- ############################################################
-- Phase 3: Wallets
-- ############################################################

CREATE TABLE wallet_pair_stats (
  chain              TEXT NOT NULL,
  pair               TEXT NOT NULL,
  wallet             TEXT NOT NULL,
  first_time         TIMESTAMPTZ NOT NULL,
  first_block        BIGINT NOT NULL,
  last_time          TIMESTAMPTZ NOT NULL,
  last_block         BIGINT NOT NULL,
  operations_count   BIGINT NOT NULL DEFAULT 0,
  sniper             BOOLEAN NOT NULL DEFAULT false,

  buys_count             BIGINT  NOT NULL DEFAULT 0,
  buys_amount_token      NUMERIC(76,18) NOT NULL DEFAULT 0,
  buys_amount_native     NUMERIC(76,18) NOT NULL DEFAULT 0,
  buys_amount_tokenref   NUMERIC(76,18) NOT NULL DEFAULT 0,
  buys_value_usd         NUMERIC(76,18) NOT NULL DEFAULT 0,   -- numerador: Σ amount×price
  buys_value_native      NUMERIC(76,18) NOT NULL DEFAULT 0,
  buys_price_usd_max     NUMERIC(76,18),
  buys_price_usd_min     NUMERIC(76,18),
  buys_price_native_max  NUMERIC(76,18),
  buys_price_native_min  NUMERIC(76,18),

  sells_count             BIGINT  NOT NULL DEFAULT 0,
  sells_amount_token      NUMERIC(76,18) NOT NULL DEFAULT 0,
  sells_amount_native     NUMERIC(76,18) NOT NULL DEFAULT 0,
  sells_amount_tokenref   NUMERIC(76,18) NOT NULL DEFAULT 0,
  sells_value_usd         NUMERIC(76,18) NOT NULL DEFAULT 0,
  sells_value_native      NUMERIC(76,18) NOT NULL DEFAULT 0,
  sells_price_usd_max     NUMERIC(76,18),
  sells_price_usd_min     NUMERIC(76,18),
  sells_price_native_max  NUMERIC(76,18),
  sells_price_native_min  NUMERIC(76,18),

  op_speed_hour BIGINT NOT NULL DEFAULT 0,
  op_speed_day  BIGINT NOT NULL DEFAULT 0,
  op_speed_hold BIGINT NOT NULL DEFAULT 0,

  PRIMARY KEY (chain, pair, wallet)
);

CREATE TABLE wallet_pair_liquidity (
  chain    TEXT NOT NULL,
  pair     TEXT NOT NULL,
  wallet   TEXT NOT NULL,
  first_time  TIMESTAMPTZ NOT NULL,
  first_block BIGINT NOT NULL,
  last_time   TIMESTAMPTZ NOT NULL,
  last_block  BIGINT NOT NULL,

  adds    BIGINT NOT NULL DEFAULT 0,
  removes BIGINT NOT NULL DEFAULT 0,
  burns   BIGINT NOT NULL DEFAULT 0,
  locks   BIGINT NOT NULL DEFAULT 0,
  unlocks BIGINT NOT NULL DEFAULT 0,

  balance_token    NUMERIC(76,18) NOT NULL DEFAULT 0,
  balance_tokenref NUMERIC(76,18) NOT NULL DEFAULT 0,

  balance_lp_token_burned   NUMERIC(76,18) NOT NULL DEFAULT 0,
  balance_lp_token_added    NUMERIC(76,18) NOT NULL DEFAULT 0,
  balance_lp_token_removed  NUMERIC(76,18) NOT NULL DEFAULT 0,
  balance_lp_token_locked   NUMERIC(76,18) NOT NULL DEFAULT 0,
  balance_lp_token_unlocked NUMERIC(76,18) NOT NULL DEFAULT 0,
  balance_lp_token          NUMERIC(76,18) NOT NULL DEFAULT 0,

  PRIMARY KEY (chain, pair, wallet)
);
