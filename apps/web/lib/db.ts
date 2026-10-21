import { neon } from '@neondatabase/serverless';

/**
 * Read-only queries against the whale-tracker Neon DB.
 * On Vercel the Neon integration injects DATABASE_URL for the whale-tracker store (auto-updated on
 * password resets). Anywhere else, DATABASE_URL may be the ArbScout DB (shared Claude cloud env), so
 * only WHALE_DATABASE_URL is trusted off-Vercel.
 */
function databaseUrl(): string {
  const url = process.env.WHALE_DATABASE_URL ?? (process.env.VERCEL ? process.env.DATABASE_URL : undefined);
  if (!url) throw new Error('Set WHALE_DATABASE_URL (or deploy on Vercel with the Neon integration)');
  return url;
}

export const sql = () => neon(databaseUrl());

export interface WhaleRow {
  id: string;
  platform: 'kalshi' | 'pmus';
  league: string;
  taker_side: 'yes' | 'no';
  taker_intent: string | null;
  first_ts: string;
  fills: number;
  notional_usd: string;
  vwap_price: string;
  potential_payout_usd: string;
  title: string | null;
  team: string | null;
  game_start: string | null;
  away_name: string | null;
  home_name: string | null;
}

export async function recentWhales(minUsd: number, hours: number, limit = 100): Promise<WhaleRow[]> {
  const rows = await sql()`
    SELECT w.id::text, w.platform, w.league, w.taker_side, w.taker_intent, w.first_ts, w.fills,
           w.notional_usd, w.vwap_price, w.potential_payout_usd,
           m.title, m.yes_sub_title AS team, g.start_time AS game_start, g.away_name, g.home_name
    FROM whale_orders w
    LEFT JOIN markets m ON m.platform = w.platform AND m.market_ticker = w.market_ticker
    LEFT JOIN games g ON g.game_id = m.game_id
    WHERE w.league IN ('NBA', 'NFL')
      AND w.notional_usd >= ${minUsd}
      AND w.first_ts > now() - make_interval(hours => ${hours})
    ORDER BY w.first_ts DESC
    LIMIT ${limit}`;
  return rows as WhaleRow[];
}

export interface LeagueSummary {
  league: string;
  orders: number;
  volume_usd: string;
  biggest_usd: string;
}

export async function summary(hours: number): Promise<LeagueSummary[]> {
  const rows = await sql()`
    SELECT league, count(*)::int AS orders, sum(notional_usd) AS volume_usd, max(notional_usd) AS biggest_usd
    FROM whale_orders
    WHERE league IN ('NBA', 'NFL') AND notional_usd >= 25000 AND first_ts > now() - make_interval(hours => ${hours})
    GROUP BY league ORDER BY league`;
  return rows as LeagueSummary[];
}
