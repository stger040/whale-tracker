/**
 * Live trade collector: Kalshi + PM.US exchange-wide trade streams → Neon.
 *
 * Both platforms stream EVERY trade from a single subscription; we keep sports game markets
 * (Kalshi series in KALSHI_SERIES, PM.US aec-{league}- slugs) and:
 *   - store trades ≥ MIN_STORE_USD in `trades` (same table/ids as the backfill — idempotent),
 *   - add every trade to per-market histograms (`market_trade_stats`, additive),
 *   - cluster fills into taker orders and log those ≥ WHALE_LOG_MIN_USD to `whale_orders`,
 *   - upsert `markets` metadata the first time a market is seen.
 *
 * Never places orders. Run under systemd (whale-live.service) with TZ=America/Chicago.
 */
import WebSocket from 'ws';
import {
  KALSHI_WS, KalshiRestClient, NotionalHistogram, PMUS_WS, fetchPmusMarket, kalshiSeriesLeague,
  kalshiWsHeaders, kalshiWsTradeToRaw, normalizeKalshiMarket, normalizeKalshiTrade, normalizePmusTrade,
  parseLeagues, pmusSlugLeague, pmusWsHeaders, type KalshiWsTradeMsg, type League, type NormalizedTrade, type PmusTradeMsg,
} from '@whale/core';
import { FillClusterer } from './clusterer.js';
import { TelegramAlerter, type MarketLabel } from './telegram.js';
import { linkMarketFromDb } from './link-games.js';
import { addLiveStats, createPool, insertTrades, insertWhaleOrder, knownMarkets, upsertMarket, type WhaleOrder } from './db.js';

const MIN_STORE_USD = Number(process.env.MIN_STORE_USD ?? 500);
const WHALE_LOG_MIN_USD = Number(process.env.WHALE_LOG_MIN_USD ?? 5000);
const CLUSTER_GAP_MS = Number(process.env.CLUSTER_GAP_MS ?? 1500);
const FLUSH_MS = 5_000;
const STATS_FLUSH_MS = 60_000;
const SILENCE_RECONNECT_MS = 60_000;
/** On DB outages, keep at most this many unsaved trades in memory (oldest dropped first). */
const MAX_PENDING_TRADES = 200_000;

const log = (msg: string) => console.log(`${new Date().toLocaleString()} ${msg}`);
const usd = (n: number) => `$${Math.round(n).toLocaleString()}`;

const pool = createPool();
const kalshiRest = new KalshiRestClient(2);
const seriesLeague = kalshiSeriesLeague();
const activeLeagues = new Set<League>(parseLeagues());
const seen = await knownMarkets(pool);

let tradeBuf: NormalizedTrade[] = [];
const whaleBuf: WhaleOrder[] = [];
const stats = new Map<string, { platform: string; ticker: string; league: League; h: NotionalHistogram; first: Date; last: Date }>();
const counters = { kalshiMsgs: 0, kalshiSports: 0, pmusMsgs: 0, pmusSports: 0, stored: 0, whales: 0, errors: 0 };

// Market labels for alerts: filled when a market is registered, else looked up in the DB once.
const labels = new Map<string, MarketLabel>();
async function lookupLabel(platform: string, ticker: string): Promise<MarketLabel | null> {
  const key = `${platform}:${ticker}`;
  if (labels.has(key)) return labels.get(key)!;
  const r = await pool.query<{ title: string | null; yes_sub_title: string | null; start_time: Date | null }>(
    `SELECT m.title, m.yes_sub_title, g.start_time FROM markets m LEFT JOIN games g ON g.game_id = m.game_id
      WHERE m.platform = $1 AND m.market_ticker = $2`, [platform, ticker]);
  if (!r.rows[0]) return null;
  const label = { title: r.rows[0].title, yesSubTitle: r.rows[0].yes_sub_title, gameStart: r.rows[0].start_time };
  // Only cache once linked to a game; unlinked markets get re-checked (the daily sync links them).
  if (label.gameStart) labels.set(key, label);
  return label;
}
const telegram = new TelegramAlerter(pool, lookupLabel, log);

const clusterer = new FillClusterer(CLUSTER_GAP_MS, o => {
  void telegram.consider(o).catch(err => log(`[Telegram] ${err}`));
  if (o.notionalUsd < WHALE_LOG_MIN_USD) return;
  whaleBuf.push(o);
  counters.whales++;
  log(`[WHALE] ${o.platform} ${o.marketTicker} ${o.takerSide.toUpperCase()} ${usd(o.notionalUsd)} ` +
      `@ ${(o.vwapPrice * 100).toFixed(1)}¢ (${o.fills} fills, payout ${usd(o.contracts)})` +
      (o.takerIntent ? ` ${o.takerIntent.replace('ORDER_INTENT_', '')}` : ''));
});

function onTrade(t: NormalizedTrade): void {
  if (t.notionalUsd >= MIN_STORE_USD) tradeBuf.push(t);
  const key = `${t.platform}:${t.marketTicker}`;
  let s = stats.get(key);
  if (!s) stats.set(key, (s = { platform: t.platform, ticker: t.marketTicker, league: t.league, h: new NotionalHistogram(false), first: t.ts, last: t.ts }));
  s.h.add(t.notionalUsd);
  if (t.ts < s.first) s.first = t.ts;
  if (t.ts > s.last) s.last = t.ts;
  clusterer.add(t);
  if (!seen.has(key)) {
    seen.add(key);
    void registerMarket(t).catch(err => { counters.errors++; seen.delete(key); log(`[Markets] ${key} failed: ${err}`); });
  }
}

async function registerMarket(t: NormalizedTrade): Promise<void> {
  if (t.platform === 'kalshi') {
    const m = await kalshiRest.getMarket(t.marketTicker);
    const series = t.marketTicker.split('-')[0];
    if (m) {
      const meta = normalizeKalshiMarket(m, series, t.league);
      await upsertMarket(pool, meta);
    }
  } else {
    const m = await fetchPmusMarket(t.marketTicker, t.league);
    await upsertMarket(pool, m ?? {
      platform: 'pmus', marketTicker: t.marketTicker, eventTicker: t.marketTicker,
      seriesTicker: `aec-${t.marketTicker.split('-')[1]}`, league: t.league,
      title: null, yesSubTitle: null, openTime: null, closeTime: null, result: null,
    });
  }
  const linked = await linkMarketFromDb(pool, t.platform, t.league, t.marketTicker, t.eventTicker).catch(() => false);
  log(`[Markets] new ${t.platform} ${t.marketTicker}${linked ? ' (game linked)' : ''}`);
}

// ── WebSocket plumbing: reconnect with backoff, and on silence ────────────────

function connect(
  name: string, url: string, headers: () => Record<string, string>,
  subscribe: (ws: WebSocket) => void, onMessage: (data: unknown) => void,
): void {
  let attempt = 0;
  const open = () => {
    const ws = new WebSocket(url, { headers: headers() });
    let lastMsg = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastMsg > SILENCE_RECONNECT_MS) {
        log(`[${name}] silent for ${SILENCE_RECONNECT_MS / 1000}s — reconnecting`);
        ws.terminate();
      }
    }, 10_000);
    ws.on('open', () => { attempt = 0; log(`[${name}] connected`); subscribe(ws); });
    ws.on('message', d => {
      lastMsg = Date.now();
      try { onMessage(JSON.parse(d.toString())); } catch (err) { counters.errors++; log(`[${name}] bad frame: ${err}`); }
    });
    ws.on('unexpected-response', (_req, res) => log(`[${name}] HTTP ${res.statusCode} on connect`));
    ws.on('error', err => log(`[${name}] error: ${err.message}`));
    ws.on('close', code => {
      clearInterval(watchdog);
      const delay = Math.min(60_000, 1000 * 2 ** attempt++);
      log(`[${name}] closed (${code}) — retry in ${delay / 1000}s`);
      setTimeout(open, delay);
    });
  };
  open();
}

connect('KalshiWs', KALSHI_WS,
  () => kalshiWsHeaders(process.env.KALSHI_API_KEY_ID ?? '', process.env.KALSHI_PRIVATE_KEY ?? ''),
  ws => ws.send(JSON.stringify({ id: 1, cmd: 'subscribe', params: { channels: ['trade'] } })),
  data => {
    const m = data as { type?: string; msg?: KalshiWsTradeMsg };
    if (m.type !== 'trade' || !m.msg) {
      if (m.type === 'error') log(`[KalshiWs] ${JSON.stringify(m)}`);
      return;
    }
    counters.kalshiMsgs++;
    const league = seriesLeague.get(m.msg.market_ticker.split('-')[0]);
    if (!league || !activeLeagues.has(league)) return;
    counters.kalshiSports++;
    const eventTicker = m.msg.market_ticker.split('-').slice(0, 2).join('-');
    onTrade(normalizeKalshiTrade(kalshiWsTradeToRaw(m.msg), eventTicker, league));
  });

connect('PmusWs', PMUS_WS,
  () => pmusWsHeaders(process.env.POLYMARKET_KEY_ID ?? '', process.env.POLYMARKET_SECRET_KEY ?? ''),
  ws => ws.send(JSON.stringify({ subscribe: { requestId: 'trades', subscriptionType: 'SUBSCRIPTION_TYPE_TRADE', marketSlugs: [] } })),
  data => {
    const m = data as { trade?: PmusTradeMsg; error?: string };
    if (m.error) { log(`[PmusWs] ${JSON.stringify(m)}`); return; }
    if (!m.trade) return; // heartbeats
    counters.pmusMsgs++;
    const league = pmusSlugLeague(m.trade.marketSlug);
    if (!league || !activeLeagues.has(league)) return;
    counters.pmusSports++;
    onTrade(normalizePmusTrade(m.trade, league));
  });

// ── Flush loops ───────────────────────────────────────────────────────────────

let flushing = false;
setInterval(async () => {
  clusterer.sweep();
  if (flushing) return;
  flushing = true;
  const trades = tradeBuf.splice(0);
  try {
    if (trades.length) { await insertTrades(pool, trades); counters.stored += trades.length; }
  } catch (err) {
    // Requeue (inserts are idempotent) so a DB outage — e.g. a rotated password — doesn't lose data.
    tradeBuf = trades.concat(tradeBuf); // concat, not unshift(...): backlog can exceed arg limits
    if (tradeBuf.length > MAX_PENDING_TRADES) tradeBuf = tradeBuf.slice(tradeBuf.length - MAX_PENDING_TRADES);
    counters.errors++;
    log(`[Flush] trades: ${err} (pending=${tradeBuf.length})`);
  }
  while (whaleBuf.length) {
    try {
      await insertWhaleOrder(pool, whaleBuf[0]);
      whaleBuf.shift();
    } catch (err) {
      counters.errors++;
      log(`[Flush] whale_orders: ${err} (pending=${whaleBuf.length})`);
      break;
    }
  }
  flushing = false;
}, FLUSH_MS);

setInterval(async () => {
  const batch = [...stats.values()];
  stats.clear();
  for (const s of batch) {
    try {
      await addLiveStats(pool, s.platform, s.ticker, s.league, s.h.counts, s.h.sums, s.first, s.last, s.h.max() ?? 0);
    } catch (err) {
      // Merge back into the next cycle rather than dropping the counts.
      const key = `${s.platform}:${s.ticker}`;
      const cur = stats.get(key);
      if (cur) {
        s.h.counts.forEach((c, i) => { cur.h.counts[i] += c; cur.h.sums[i] += s.h.sums[i]; });
        if (s.first < cur.first) cur.first = s.first;
      } else stats.set(key, s);
      counters.errors++;
      log(`[Stats] ${s.ticker}: ${err}`);
    }
  }
  log(`[Stats] kalshi=${counters.kalshiSports}/${counters.kalshiMsgs} pmus=${counters.pmusSports}/${counters.pmusMsgs} ` +
      `stored=${counters.stored} whales=${counters.whales} tg=${telegram.sent}/${telegram.subscriberCount}subs markets=${batch.length} err=${counters.errors}`);
}, STATS_FLUSH_MS);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    log(`[Live] ${sig} — flushing`);
    clusterer.flushAll();
    try {
      if (tradeBuf.length) await insertTrades(pool, tradeBuf.splice(0));
      for (const w of whaleBuf.splice(0)) await insertWhaleOrder(pool, w);
    } finally {
      await pool.end();
      process.exit(0);
    }
  });
}

log(`[Live] started leagues=${[...activeLeagues].join(',')} minStore=${usd(MIN_STORE_USD)} whaleLog=${usd(WHALE_LOG_MIN_USD)} clusterGap=${CLUSTER_GAP_MS}ms knownMarkets=${seen.size}`);
