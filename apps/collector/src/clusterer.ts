import type { NormalizedTrade } from '@whale/core';
import type { WhaleOrder } from './db.js';

/**
 * Groups fills into taker orders: same platform + market + taker side, each fill within
 * `gapMs` of the previous one. A sweep across several price levels arrives as a burst of
 * fills (often the exact same ms on Kalshi), so this turns "12 fills of $4k" into one $48k order.
 * Clusters are emitted once no new fill has arrived for `gapMs`.
 */
export class FillClusterer {
  private open = new Map<string, { order: WhaleOrder; lastSeen: number; priceVol: number }>();

  constructor(
    private readonly gapMs: number,
    private readonly onOrder: (o: WhaleOrder) => void,
  ) {}

  add(t: NormalizedTrade): void {
    const key = `${t.platform}|${t.marketTicker}|${t.takerSide}`;
    const tsMs = t.ts.getTime();
    const cur = this.open.get(key);
    if (cur && tsMs - cur.order.lastTs.getTime() <= this.gapMs) {
      const o = cur.order;
      o.fills++;
      o.contracts += t.contracts;
      o.notionalUsd += t.notionalUsd;
      cur.priceVol += t.takerPrice * t.contracts;
      o.vwapPrice = o.contracts ? cur.priceVol / o.contracts : t.takerPrice;
      o.minPrice = Math.min(o.minPrice, t.takerPrice);
      o.maxPrice = Math.max(o.maxPrice, t.takerPrice);
      if (tsMs > o.lastTs.getTime()) o.lastTs = t.ts;
      o.tradeIds.push(t.tradeId);
      cur.lastSeen = Date.now();
      return;
    }
    if (cur) this.emit(key);
    this.open.set(key, {
      lastSeen: Date.now(),
      priceVol: t.takerPrice * t.contracts,
      order: {
        platform: t.platform, marketTicker: t.marketTicker, eventTicker: t.eventTicker, league: t.league,
        takerSide: t.takerSide, takerIntent: t.takerIntent ?? null,
        firstTs: t.ts, lastTs: t.ts, fills: 1, contracts: t.contracts, notionalUsd: t.notionalUsd,
        vwapPrice: t.takerPrice, minPrice: t.takerPrice, maxPrice: t.takerPrice, tradeIds: [t.tradeId],
      },
    });
  }

  /** Emit clusters idle for longer than gapMs (call on a timer). */
  sweep(now = Date.now()): void {
    for (const [key, c] of this.open) if (now - c.lastSeen > this.gapMs) this.emit(key);
  }

  flushAll(): void {
    for (const key of [...this.open.keys()]) this.emit(key);
  }

  private emit(key: string): void {
    const c = this.open.get(key);
    if (!c) return;
    this.open.delete(key);
    this.onOrder(c.order);
  }
}
