-- Lets multiple `swaps` instances run concurrently against the same
-- database: each run registers itself under its own execution id instead
-- of the old design where chain_pairs was truncated at the start of every
-- run (which would wipe out a concurrently-running instance's rows).
--
-- chain_pairs is superseded here (dropped and recreated) — it's disposable
-- reference data, not user data, so this is safe to run even against an
-- already-initialized database.
--
-- Both tables carry an explicit expires_at instead of relying on a
-- background job (no pg_cron in this image): the swaps app deletes expired
-- rows from both tables at the start of every run, before publishing its
-- own. The chain_pairs -> swaps_executions foreign key also cascades on
-- delete, as a second line of defense if a chain_pairs row's expires_at
-- ever drifts from its execution's.

CREATE TABLE IF NOT EXISTS swaps_executions (
    id         TEXT NOT NULL PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_swaps_executions_expires_at ON swaps_executions (expires_at);

DROP TABLE IF EXISTS chain_pairs;
CREATE TABLE chain_pairs (
    execution_id TEXT NOT NULL REFERENCES swaps_executions (id) ON DELETE CASCADE,
    chain        TEXT NOT NULL,
    pair         TEXT NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (execution_id, chain, pair)
);
CREATE INDEX IF NOT EXISTS idx_chain_pairs_expires_at ON chain_pairs (expires_at);
