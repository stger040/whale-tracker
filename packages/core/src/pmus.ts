/**
 * Polymarket US (PM.US) — auth, market metadata, and trade-stream parsing.
 *
 * Confirmed 2026-10-21 (live WS capture):
 *  - Subscribing SUBSCRIPTION_TYPE_TRADE with marketSlugs: [] streams EVERY trade on the exchange.
 *  - trade = { marketSlug, price:{value}, quantity:{value}, tradeTime (ns ISO), id, state,
 *              maker:{side,intent,outcomeSide,action}, taker:{side,intent,outcomeSide,action} }
 *  - price is always the YES (long) price. quantity is contracts (despite currency:"USD").
 *  - taker.side ORDER_SIDE_BUY  → taker gained YES exposure (BUY_LONG open, or SELL_SHORT close)
 *    taker.side ORDER_SIDE_SELL → taker gained NO exposure  (BUY_SHORT open, or SELL_LONG close)
 *    intent is sometimes ORDER_INTENT_UNDEFINED.
 *  - Game-winner markets: slug aec-{league}-{a}-{b}-{yyyy-mm-dd}. No historical trades endpoint.
 */
import crypto from 'node:crypto';
import type { League, MarketMeta, NormalizedTrade } from './types.js';

export const PMUS_WS = 'wss://api.polymarket.us/v1/ws/markets';
export const PMUS_GATEWAY = 'https://gateway.polymarket.us';
const PMUS_WS_PATH = '/v1/ws/markets';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** Slug league token → our League. Only game-winner (aec-) markets for now. */
const PMUS_LEAGUES: Record<string, League> = { nfl: 'NFL', nba: 'NBA', mlb: 'MLB', atp: 'ATP', wta: 'WTA', pga: 'PGA' };

export function pmusSlugLeague(slug: string): League | null {
  const [kind, league] = slug.split('-', 2);
  if (kind !== 'aec') return null;
  return PMUS_LEAGUES[league] ?? null;
}

export function pmusWsHeaders(keyId: string, secretKeyBase64: string): Record<string, string> {
  const raw = Buffer.from(secretKeyBase64, 'base64');
  const seed = raw.length === 64 ? raw.subarray(0, 32) : raw;
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
  const ts = Date.now().toString();
  const sig = crypto.sign(null, Buffer.from(`${ts}GET${PMUS_WS_PATH}`, 'utf8'), key).toString('base64');
  return { 'X-PM-Access-Key': keyId, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig };
}

export interface PmusTradeMsg {
  marketSlug: string;
  id: string;
  price: { value: string };
  quantity: { value: string };
  tradeTime: string;
  taker: { side: string; intent?: string };
}

export function normalizePmusTrade(t: PmusTradeMsg, league: League): NormalizedTrade {
  const yesPrice = Number(t.price.value);
  const takerSide = t.taker.side === 'ORDER_SIDE_SELL' ? 'no' : 'yes';
  const takerPrice = takerSide === 'yes' ? yesPrice : 1 - yesPrice;
  const contracts = Number(t.quantity.value);
  return {
    platform: 'pmus',
    tradeId: t.id,
    marketTicker: t.marketSlug,
    eventTicker: t.marketSlug, // aec- slugs are one market per game
    league,
    ts: new Date(t.tradeTime), // ns precision truncates to ms
    takerSide,
    takerPrice,
    yesPrice,
    contracts,
    notionalUsd: contracts * takerPrice,
    isBlockTrade: false,
    takerIntent: t.taker.intent && t.taker.intent !== 'ORDER_INTENT_UNDEFINED' ? t.taker.intent : null,
  };
}

interface PmusMarketRaw {
  slug: string;
  question?: string;
  outcomes?: string; // JSON array string, e.g. '["Rams","Bears"]' — YES is the first outcome
  gameStartTime?: string;
  endDate?: string;
  outcomePrices?: string;
  closed?: boolean;
}

/** Public market metadata from the gateway; null if unavailable. */
export async function fetchPmusMarket(slug: string, league: League): Promise<MarketMeta | null> {
  try {
    const r = await fetch(`${PMUS_GATEWAY}/v1/market/slug/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return null;
    const m = ((await r.json()) as { market?: PmusMarketRaw }).market;
    if (!m) return null;
    let outcomes: string[] = [];
    try { outcomes = JSON.parse(m.outcomes ?? '[]'); } catch { /* leave empty */ }
    return {
      platform: 'pmus',
      marketTicker: slug,
      eventTicker: slug,
      seriesTicker: `aec-${slug.split('-')[1]}`,
      league,
      title: m.question ?? null,
      yesSubTitle: outcomes[0] ?? null,
      openTime: m.gameStartTime ? new Date(m.gameStartTime) : null,
      closeTime: m.endDate ? new Date(m.endDate) : null,
      result: null,
    };
  } catch {
    return null;
  }
}
