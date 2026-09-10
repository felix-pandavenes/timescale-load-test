import type { SwapEvent } from "../domain.js";

const BASE58_CHARSET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function randomBase58(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += BASE58_CHARSET[Math.floor(Math.random() * BASE58_CHARSET.length)];
  }
  return out;
}

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

/** Running state of a single (chain, pair) pool, carried across successive
 * swaps so price/liquidity move as a random walk. */
export class PairState {
  private price: number;
  private liquidity: number;
  private blockNumber: number;
  private poolToken: number;
  private poolTokenRef: number;
  private readonly refUsd: number; // USD price of the pool's reference/quote currency

  constructor() {
    const poolToken = 1_000_000 + Math.random() * 500_000_000;
    const price = 1e-7 + Math.random() * 1e-2;
    const refUsd = 50 + Math.random() * 3_500;
    const poolTokenRef = (poolToken * price) / refUsd;

    this.price = price;
    this.liquidity = poolToken * price + poolTokenRef * refUsd;
    this.blockNumber = 400_000_000 + randomInt(50_000_000);
    this.poolToken = poolToken;
    this.poolTokenRef = poolTokenRef;
    this.refUsd = refUsd;
  }

  /** Advances the pool by one trade and returns the resulting swap event.
   * chain/pair are left unset — the caller fills those in. */
  next(): Omit<SwapEvent, "chain" | "pair"> {
    const isBuy = Math.random() < 0.5;

    const amountToken = this.poolToken * (0.00001 + Math.random() * 0.001);
    const priceDelta = (amountToken / this.poolToken) * (0.5 + Math.random());
    if (isBuy) {
      this.price *= 1 + priceDelta;
      this.poolToken -= amountToken;
    } else {
      this.price *= 1 - priceDelta;
      this.poolToken += amountToken;
    }
    if (this.poolToken < 1) {
      this.poolToken = 1;
    }

    const amountUsd = amountToken * this.price;
    const amountRef = amountUsd / this.refUsd;
    const priceRef = this.price / this.refUsd;

    if (isBuy) {
      this.poolTokenRef += amountRef;
    } else {
      this.poolTokenRef -= amountRef;
      if (this.poolTokenRef < 0) {
        this.poolTokenRef = 0;
      }
    }

    this.liquidity = this.poolToken * this.price + this.poolTokenRef * this.refUsd;
    this.blockNumber += 1 + randomInt(20);

    return {
      id: randomBase58(88),
      blockNumber: this.blockNumber,
      timestamp: Math.floor(Date.now() / 1000),
      type: isBuy ? "buy" : "sell",
      amountToken,
      amountEth: amountRef,
      amountRef,
      price: this.price,
      priceEth: priceRef,
      amountUsd,
      eventLiquidity: this.liquidity,
      amountLpToken: null, // only swap events are generated, no add/remove-liquidity events
      maker: randomBase58(44),
      logIndex: randomInt(300),
      bot: false,
      botAddress: null,
      scamwick: false,
    };
  }
}
