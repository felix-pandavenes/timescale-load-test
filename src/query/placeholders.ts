import { ChainPair } from "../domain.js";

/** Sentinels a query's `params` array can use in place of a literal value.
 * Resolved against a real (chain, pair) row from chain_pairs at query time,
 * so $chain/$pair in the same query always refer to the same row (never an
 * unrelated chain crossed with an unrelated pair). */
export const CHAIN_PLACEHOLDER = "$chain";
export const PAIR_PLACEHOLDER = "$pair";

export function needsChainPair(params: readonly unknown[]): boolean {
  return params.some((p) => p === CHAIN_PLACEHOLDER || p === PAIR_PLACEHOLDER);
}

/** Substitutes $chain/$pair sentinels with a randomly picked chain_pairs
 * row. Throws if the query needs them and the pool is empty (e.g. the
 * swaps generator was never run against this database) — callers already
 * catch and record query errors, so this surfaces as a normal error rather
 * than a crash. */
export function resolveParams(params: readonly unknown[], pool: readonly ChainPair[]): unknown[] {
  if (!needsChainPair(params)) {
    return params as unknown[];
  }
  if (pool.length === 0) {
    throw new Error(
      `query needs ${CHAIN_PLACEHOLDER}/${PAIR_PLACEHOLDER} but chain_pairs is empty — run the swaps generator first`,
    );
  }
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return params.map((p) => {
    if (p === CHAIN_PLACEHOLDER) return picked.chain;
    if (p === PAIR_PLACEHOLDER) return picked.pair;
    return p;
  });
}
