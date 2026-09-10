interface Agg {
  count: number;
  errors: number;
  sum: number;
  min: number;
  max: number;
}

export interface LiveStats {
  count: number;
  errors: number;
  avg: number;
  min: number;
  max: number;
}

export interface StatsSummary extends LiveStats {
  name: string;
}

function newAgg(): Agg {
  return { count: 0, errors: 0, sum: 0, min: Infinity, max: -Infinity };
}

/** Tracks count/sum/min/max of a numeric sample per named series — e.g. one
 * series per query for query latency (ms) or rows returned, or a single
 * "insert" series for swaps write latency (ms). Unit-agnostic on purpose:
 * callers decide what `record()`'s value means. O(1) memory per series and
 * per record — no raw samples are kept, so this stays cheap over
 * long/high-throughput runs. */
export class LatencyStats {
  private readonly byName = new Map<string, Agg>();

  constructor(names: string[]) {
    for (const name of names) {
      this.byName.set(name, newAgg());
    }
  }

  record(name: string, value: number): void {
    const agg = this.byName.get(name);
    if (!agg) return;
    agg.count++;
    agg.sum += value;
    if (value < agg.min) agg.min = value;
    if (value > agg.max) agg.max = value;
  }

  recordError(name: string): void {
    const agg = this.byName.get(name);
    if (agg) agg.errors++;
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  totalCount(): number {
    let n = 0;
    for (const agg of this.byName.values()) n += agg.count;
    return n;
  }

  totalErrors(): number {
    let n = 0;
    for (const agg of this.byName.values()) n += agg.errors;
    return n;
  }

  live(name: string): LiveStats {
    const agg = this.byName.get(name) ?? newAgg();
    return toLiveStats(agg);
  }

  liveTotal(): LiveStats {
    return toLiveStats(this.totalAgg());
  }

  private totalAgg(): Agg {
    const total = newAgg();
    for (const agg of this.byName.values()) {
      total.count += agg.count;
      total.errors += agg.errors;
      total.sum += agg.sum;
      if (agg.min < total.min) total.min = agg.min;
      if (agg.max > total.max) total.max = agg.max;
    }
    return total;
  }
}

function toLiveStats(agg: Agg): LiveStats {
  return {
    count: agg.count,
    errors: agg.errors,
    avg: agg.count > 0 ? agg.sum / agg.count : 0,
    min: Number.isFinite(agg.min) ? agg.min : 0,
    max: Number.isFinite(agg.max) ? agg.max : 0,
  };
}
