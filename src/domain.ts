export interface ChainPair {
  chain: string;
  pair: string;
}

export interface ChainPairRecord extends ChainPair {
  executionId: string;
}

/** One entry in the query pool. `params` are passed positionally ($1, $2, ...). */
export interface QueryDef {
  name: string;
  sql: string;
  disabled?: boolean;
  params?: unknown[];
}

export interface SwapEvent {
  chain: string;
  pair: string;
  id: string;
  blockNumber: number;
  logIndex: number;
  timestamp: number; // unix seconds
  type: "buy" | "sell";
  amountToken: number;
  amountEth: number;
  amountRef: number;
  price: number;
  priceEth: number;
  amountUsd: number;
  eventLiquidity: number;
  amountLpToken: number | null;
  maker: string;
  bot: boolean;
  botAddress: string | null;
  scamwick: boolean;
}
