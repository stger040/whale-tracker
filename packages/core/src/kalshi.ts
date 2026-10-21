/**
 * Kalshi public REST client (no auth needed for market data or the trade tape).
 *
 * Confirmed 2026-10-20:
 *  - Base URL: https://external-api.kalshi.com/trade-api/v2
 *  - Trades created before GET /historical/cutoff → trades_created_ts are served ONLY by
 *    /historical/trades; newer trades ONLY by /markets/trades. Markets settled before the
 *    cutoff are likewise only in /historical/markets. Same field names on both.
 *  - /events?series_ticker=... lists both live and settled events (back to series start).
 *  - Unauthenticated rate limit is low and returns 429 {"error":{"code":"too_many_requests"}}
 *    with no Retry-After header. ~6–8 req/s sustained is OK; bursts trip it.
 */
import type { League, MarketMeta, NormalizedTrade } from './types.js';

export const KALSHI_REST = 'https://external-api.kalshi.com/trade-api/v2';

export interface KalshiTradeRaw {
  trade_id: string;
  ticker: string;
  created_time: string;
  count_fp: string;
  yes_price_dollars: string;
  no_price_dollars: string;
  taker_side: 'yes' | 'no';
  is_block_trade?: boolean;
}

export interface KalshiMarketRaw {
  ticker: string;
  event_ticker: string;
  title?: string;
  yes_sub_title?: string;
  open_time?: string;
  close_time?: string;
  result?: string;
  status?: string;
}

export interface KalshiEventRaw {
  event_ticker: string;
  series_ticker: string;
  title?: string;
}

/** Spaces requests evenly and retries 429/5xx with exponential backoff. */
export class KalshiRestClient {
  private nextSlot = 0;
  private readonly intervalMs: number;
  requests = 0;
  retries = 0;

  constructor(reqPerSec = 8, private readonly base = KALSHI_REST) {
    this.intervalMs = 1000 / reqPerSec;
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.nextSlot - now;
    this.nextSlot = Math.max(now, this.nextSlot) + this.intervalMs;
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`;

    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      this.requests++;
      let resp: Response;
      try {
        resp = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (attempt >= 6) throw err;
        this.retries++;
        await sleep(backoffMs(attempt));
        continue;
      }
      if (resp.ok) return (await resp.json()) as T;
      if ((resp.status === 429 || resp.status >= 500) && attempt < 8) {
        this.retries++;
        // 429s mean we're over budget — also push the shared schedule back.
        const delay = backoffMs(attempt);
        this.nextSlot = Math.max(this.nextSlot, Date.now() + delay);
        await sleep(delay);
        continue;
      }
      throw new Error(`Kalshi ${resp.status} ${path}: ${(await resp.text()).slice(0, 200)}`);
    }
  }

  /** Follows `cursor` until exhausted, yielding each page's items. */
  async *paginate<T>(path: string, key: string, query: Record<string, string | number | undefined>): AsyncGenerator<T[]> {
    let cursor: string | undefined;
    do {
      const page = await this.get<Record<string, unknown>>(path, { ...query, cursor });
      const items = (page[key] as T[] | undefined) ?? [];
      if (items.length) yield items;
      cursor = (page.cursor as string | undefined) || undefined;
      if (!items.length) break;
    } while (cursor);
  }

  async historicalCutoff(): Promise<Date> {
    const r = await this.get<{ trades_created_ts: string }>('/historical/cutoff');
    return new Date(r.trades_created_ts);
  }

  async listEvents(seriesTicker: string): Promise<KalshiEventRaw[]> {
    const out: KalshiEventRaw[] = [];
    for await (const page of this.paginate<KalshiEventRaw>('/events', 'events', { series_ticker: seriesTicker, limit: 200 })) {
      out.push(...page);
    }
    return out;
  }

  /** Markets for an event, from the live endpoint or, if settled before the cutoff, the historical one. */
  async listEventMarkets(eventTicker: string): Promise<KalshiMarketRaw[]> {
    const live = await this.get<{ markets?: KalshiMarketRaw[] }>('/markets', { event_ticker: eventTicker, limit: 1000 });
    if (live.markets?.length) return live.markets;
    const hist = await this.get<{ markets?: KalshiMarketRaw[] }>('/historical/markets', { event_ticker: eventTicker, limit: 1000 });
    return hist.markets ?? [];
  }

  /**
   * Every trade for a market, from both the historical and live tapes (a market can straddle
   * the cutoff), de-duplicated by trade_id. Yields page by page to keep memory flat.
   */
  async *marketTrades(ticker: string): AsyncGenerator<KalshiTradeRaw[]> {
    const seen = new Set<string>();
    for (const path of ['/historical/trades', '/markets/trades']) {
      for await (const page of this.paginate<KalshiTradeRaw>(path, 'trades', { ticker, limit: 1000 })) {
        const fresh = page.filter(t => !seen.has(t.trade_id));
        for (const t of fresh) seen.add(t.trade_id);
        if (fresh.length) yield fresh;
      }
    }
  }
}

export function normalizeKalshiTrade(t: KalshiTradeRaw, eventTicker: string, league: League): NormalizedTrade {
  const contracts = Number(t.count_fp);
  const yesPrice = Number(t.yes_price_dollars);
  const takerPrice = t.taker_side === 'yes' ? yesPrice : Number(t.no_price_dollars);
  return {
    platform: 'kalshi',
    tradeId: t.trade_id,
    marketTicker: t.ticker,
    eventTicker,
    league,
    ts: new Date(t.created_time),
    takerSide: t.taker_side,
    takerPrice,
    yesPrice,
    contracts,
    notionalUsd: contracts * takerPrice,
    isBlockTrade: Boolean(t.is_block_trade),
  };
}

export function normalizeKalshiMarket(m: KalshiMarketRaw, seriesTicker: string, league: League): MarketMeta {
  return {
    platform: 'kalshi',
    marketTicker: m.ticker,
    eventTicker: m.event_ticker,
    seriesTicker,
    league,
    title: m.title ?? null,
    yesSubTitle: m.yes_sub_title ?? null,
    openTime: m.open_time ? new Date(m.open_time) : null,
    closeTime: m.close_time ? new Date(m.close_time) : null,
    result: m.result || null,
  };
}

function backoffMs(attempt: number): number {
  return Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
