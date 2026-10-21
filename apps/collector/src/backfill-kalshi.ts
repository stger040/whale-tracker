/**
 * Kalshi historical trade backfill.
 *
 * For each league → series → settled event → market, pulls the complete trade tape
 * (historical + live endpoints), stores trades ≥ MIN_STORE_USD, and writes an
 * all-trades size histogram per market. Resumable: markets with backfilled_at set
 * are skipped, and trade inserts are idempotent.
 *
 *   npm run backfill:kalshi -- --leagues NFL,NBA --since 2025-09-01
 *   npm run backfill:kalshi -- --leagues NFL --max-events 3 --dry-run   # no DB, prints stats
 *
 * Launch with TZ=America/Chicago so log timestamps read in Central time.
 */
import {
  KalshiRestClient, KALSHI_SERIES, NotionalHistogram, normalizeKalshiMarket, normalizeKalshiTrade,
  parseLeagues, BUCKET_EDGES_USD, type League, type NormalizedTrade,
} from '@whale/core';
import type pg from 'pg';
import { backfilledMarkets, createPool, finishMarket, insertTrades, upsertMarket } from './db.js';

interface Args {
  leagues: League[];
  since: Date | null;
  maxEvents: number;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const since = get('--since');
  return {
    leagues: parseLeagues(get('--leagues')),
    since: since ? new Date(`${since}T00:00:00Z`) : null,
    maxEvents: Number(get('--max-events') ?? Infinity),
    dryRun: argv.includes('--dry-run'),
  };
}

const log = (msg: string) => console.log(`${new Date().toLocaleString()} ${msg}`);
const usd = (n: number | null) => (n === null ? '-' : `$${Math.round(n).toLocaleString()}`);

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const minStoreUsd = Number(process.env.MIN_STORE_USD ?? 500);
  const kalshi = new KalshiRestClient(Number(process.env.KALSHI_REQ_PER_SEC ?? 8));
  const pool: pg.Pool | null = args.dryRun ? null : createPool();
  const done = pool ? await backfilledMarkets(pool, 'kalshi') : new Set<string>();
  const now = Date.now();

  log(`[Backfill] leagues=${args.leagues.join(',')} since=${args.since?.toISOString().slice(0, 10) ?? 'all'} ` +
      `minStore=${usd(minStoreUsd)} dryRun=${args.dryRun} alreadyDone=${done.size}`);

  try {
    for (const league of args.leagues) {
      const leagueHist = new NotionalHistogram(false);
      let marketsDone = 0;
      let tradesStored = 0;

      for (const series of KALSHI_SERIES[league]) {
        const events = await kalshi.listEvents(series);
        log(`[Backfill] ${league} ${series}: ${events.length} events`);
        let eventsSeen = 0;

        for (const ev of events) {
          if (eventsSeen >= args.maxEvents) break;
          const markets = await kalshi.listEventMarkets(ev.event_ticker);
          // Only markets whose trading has ended; the live collector owns open ones.
          const closed = markets
            .map(m => normalizeKalshiMarket(m, series, league))
            .filter(m => m.closeTime && m.closeTime.getTime() < now)
            .filter(m => !args.since || (m.closeTime && m.closeTime >= args.since));
          if (!closed.length) continue;
          eventsSeen++;

          for (const m of closed) {
            if (done.has(m.marketTicker)) continue;
            if (pool) await upsertMarket(pool, m);

            const hist = new NotionalHistogram();
            let first: Date | null = null;
            let last: Date | null = null;
            for await (const page of kalshi.marketTrades(m.marketTicker)) {
              const big: NormalizedTrade[] = [];
              for (const raw of page) {
                const t = normalizeKalshiTrade(raw, m.eventTicker, league);
                hist.add(t.notionalUsd);
                leagueHist.add(t.notionalUsd);
                if (!first || t.ts < first) first = t.ts;
                if (!last || t.ts > last) last = t.ts;
                if (t.notionalUsd >= minStoreUsd) big.push(t);
              }
              if (pool && big.length) await insertTrades(pool, big);
              tradesStored += big.length;
            }
            if (pool) await finishMarket(pool, m, hist, first, last);
            marketsDone++;
            log(`[Backfill] ${m.marketTicker} trades=${hist.count} vol=${usd(hist.total)} ` +
                `p99=${usd(hist.percentile(99))} p99.9=${usd(hist.percentile(99.9))} max=${usd(hist.max())} ` +
                `(req=${kalshi.requests} retry=${kalshi.retries})`);
          }
        }
      }

      log(`[Backfill] ${league} DONE markets=${marketsDone} trades=${leagueHist.count} stored=${tradesStored} ` +
          `vol=${usd(leagueHist.total)} max=${usd(leagueHist.max())}`);
      if (leagueHist.count) {
        console.log('  bucket          trades       volume');
        BUCKET_EDGES_USD.forEach((edge, i) => {
          if (!leagueHist.counts[i]) return;
          const label = i === BUCKET_EDGES_USD.length - 1 ? `${usd(edge)}+` : `${usd(edge)}–${usd(BUCKET_EDGES_USD[i + 1])}`;
          console.log(`  ${label.padEnd(16)}${String(leagueHist.counts[i]).padStart(8)}  ${usd(leagueHist.sums[i]).padStart(12)}`);
        });
      }
    }
  } finally {
    await pool?.end();
  }
}

main().catch(err => {
  console.error('[Backfill] FATAL', err);
  process.exit(1);
});
