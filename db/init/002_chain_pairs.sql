-- Reference table of the (chain, pair) universe currently being simulated
-- by the swaps generator. Repopulated (TRUNCATE + INSERT) every time the
-- swaps app starts, so the read load tester can look up real chain/pair
-- values to use as query parameters instead of hardcoded ones.
CREATE TABLE IF NOT EXISTS chain_pairs (
    chain TEXT NOT NULL,
    pair  TEXT NOT NULL,
    PRIMARY KEY (chain, pair)
);
