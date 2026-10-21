import pg from 'pg';
import type { MarketMeta, NormalizedTrade, NotionalHistogram } from '@whale/core';
import { BUCKET_EDGES_USD } from '@whale/core';

export function createPool(): pg.Pool {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set (see .env.example)');
  return new pg.Pool({ connectionString: url, max: 4 });
}

export async function upsertMarket(pool: pg.Pool, m: MarketMeta): Promise<void> {
  await pool.query(
    `INSERT INTO markets (platform, market_ticker, event_ticker, series_ticker, league, title,
                          yes_sub_title, open_time, close_time, result)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (platform, market_ticker) DO UPDATE SET
       title = EXCLUDED.title, yes_sub_title = EXCLUDED.yes_sub_title,
       open_time = EXCLUDED.open_time, close_time = EXCLUDED.close_time, result = EXCLUDED.result`,
    [m.platform, m.marketTicker, m.eventTicker, m.seriesTicker, m.league, m.title,
     m.yesSubTitle, m.openTime, m.closeTime, m.result],
  );
}

/** Platform+ticker pairs already fully backfilled, for resuming. */
export async function backfilledMarkets(pool: pg.Pool, platform: string): Promise<Set<string>> {
  const r = await pool.query<{ market_ticker: string }>(
    'SELECT market_ticker FROM markets WHERE platform = $1 AND backfilled_at IS NOT NULL', [platform]);
  return new Set(r.rows.map(x => x.market_ticker));
}

export async function insertTrades(pool: pg.Pool, trades: NormalizedTrade[]): Promise<void> {
  // Batched multi-row insert; 12 params per row keeps us well under pg's 65535 limit at 1000 rows.
  for (let i = 0; i < trades.length; i += 1000) {
    const chunk = trades.slice(i, i + 1000);
    const values: unknown[] = [];
    const rows = chunk.map((t, j) => {
      values.push(t.platform, t.tradeId, t.marketTicker, t.eventTicker, t.league, t.ts,
        t.takerSide, t.takerPrice, t.yesPrice, t.contracts, t.notionalUsd, t.isBlockTrade);
      const o = j * 12;
      return `(${Array.from({ length: 12 }, (_, k) => `$${o + k + 1}`).join(',')})`;
    });
    await pool.query(
      `INSERT INTO trades (platform, trade_id, market_ticker, event_ticker, league, ts, taker_side,
                           taker_price, yes_price, contracts, notional_usd, is_block_trade)
       VALUES ${rows.join(',')} ON CONFLICT DO NOTHING`,
      values,
    );
  }
}

export async function finishMarket(
  pool: pg.Pool, m: MarketMeta, h: NotionalHistogram, firstTs: Date | null, lastTs: Date | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO market_trade_stats (platform, market_ticker, league, trade_count, total_notional,
         p50_usd, p90_usd, p99_usd, p999_usd, max_usd, bucket_edges_usd, bucket_counts, bucket_sums,
         first_trade_ts, last_trade_ts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (platform, market_ticker) DO UPDATE SET
         trade_count = EXCLUDED.trade_count, total_notional = EXCLUDED.total_notional,
         p50_usd = EXCLUDED.p50_usd, p90_usd = EXCLUDED.p90_usd, p99_usd = EXCLUDED.p99_usd,
         p999_usd = EXCLUDED.p999_usd, max_usd = EXCLUDED.max_usd,
         bucket_edges_usd = EXCLUDED.bucket_edges_usd, bucket_counts = EXCLUDED.bucket_counts,
         bucket_sums = EXCLUDED.bucket_sums, first_trade_ts = EXCLUDED.first_trade_ts,
         last_trade_ts = EXCLUDED.last_trade_ts, computed_at = now()`,
      [m.platform, m.marketTicker, m.league, h.count, h.total,
       h.percentile(50), h.percentile(90), h.percentile(99), h.percentile(99.9), h.max(),
       [...BUCKET_EDGES_USD], h.counts, h.sums, firstTs, lastTs],
    );
    await client.query(
      'UPDATE markets SET backfilled_at = now() WHERE platform = $1 AND market_ticker = $2',
      [m.platform, m.marketTicker]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
