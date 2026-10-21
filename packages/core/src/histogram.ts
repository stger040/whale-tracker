/**
 * Fixed USD-notional buckets. Every trade (including ones below MIN_STORE_USD
 * that are not stored row-by-row) lands in a bucket, so per-market histograms
 * can be summed into exact league-wide trade-size distributions.
 *
 * Bucket i covers [EDGES[i], EDGES[i+1]); the last bucket is open-ended.
 */
export const BUCKET_EDGES_USD = [
  0, 10, 25, 50, 100, 250, 500, 1_000, 2_500, 5_000,
  10_000, 25_000, 50_000, 100_000, 250_000, 500_000, 1_000_000,
] as const;

export function bucketIndex(usd: number): number {
  let i = BUCKET_EDGES_USD.length - 1;
  while (i > 0 && usd < BUCKET_EDGES_USD[i]) i--;
  return i;
}

export class NotionalHistogram {
  readonly counts = new Array<number>(BUCKET_EDGES_USD.length).fill(0);
  readonly sums = new Array<number>(BUCKET_EDGES_USD.length).fill(0);
  private values: number[] = [];
  private n = 0;
  private maxSeen = -Infinity;

  /** keepValues=false for league-wide rollups: buckets only, no exact percentiles, flat memory. */
  constructor(private readonly keepValues = true) {}

  add(usd: number): void {
    const i = bucketIndex(usd);
    this.counts[i]++;
    this.sums[i] += usd;
    this.n++;
    if (usd > this.maxSeen) this.maxSeen = usd;
    if (this.keepValues) this.values.push(usd);
  }

  get count(): number { return this.n; }
  get total(): number { return this.sums.reduce((a, b) => a + b, 0); }

  /** Exact percentile over the trades seen (p in 0–100). */
  percentile(p: number): number | null {
    if (!this.values.length) return null;
    const sorted = [...this.values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))];
  }

  max(): number | null {
    return this.n ? this.maxSeen : null;
  }
}
