/**
 * Syncs ESPN games for the active leagues and links Kalshi + PM.US markets to them (markets.game_id).
 *
 *   npm run sync:games                       # default: 3 days back → 7 days ahead (daily timer)
 *   npm run sync:games -- --from 2025-04-01  # full history
 */
import { espnSupports, fetchEspnScoreboard, parseLeagues, yyyymmdd, type EspnGame } from '@whale/core';
import { createPool } from './db.js';
import { matchGame } from './link-games.js';

const DAY = 86_400_000;
const argv = process.argv.slice(2);
const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const now = Date.now();
const from = arg('--from') ? Date.parse(`${arg('--from')}T00:00:00Z`) : now - 3 * DAY;
const to = arg('--to') ? Date.parse(`${arg('--to')}T00:00:00Z`) : now + 7 * DAY;
const log = (msg: string) => console.log(`${new Date().toLocaleString()} ${msg}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const pool = createPool();
try {
  for (const league of parseLeagues().filter(espnSupports)) {
    // 1. ESPN games by schedule date
    const byDate = new Map<string, EspnGame[]>();
    let n = 0;
    for (let t = from; t <= to; t += DAY) {
      const day = yyyymmdd(new Date(t));
      const games = await fetchEspnScoreboard(league, day);
      byDate.set(day, games);
      for (const g of games) {
        await pool.query(
          `INSERT INTO games (game_id, league, start_time, away_abbr, home_abbr, away_name, home_name, status, away_score, home_score)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (game_id) DO UPDATE SET start_time = EXCLUDED.start_time, status = EXCLUDED.status,
             away_score = EXCLUDED.away_score, home_score = EXCLUDED.home_score, updated_at = now()`,
          [`espn:${g.espnId}`, league, g.startTime, g.awayAbbr, g.homeAbbr, g.awayName, g.homeName, g.status, g.awayScore, g.homeScore]);
        n++;
      }
      await sleep(150);
    }
    log(`[Games] ${league}: ${n} ESPN games ${yyyymmdd(new Date(from))}..${yyyymmdd(new Date(to))}`);

    // Candidate games for a schedule date (± 1 day: tickers use the US date, late games cross UTC midnight).
    const near = (d: Date) => [-1, 0, 1].flatMap(o => byDate.get(yyyymmdd(new Date(d.getTime() + o * DAY))) ?? []);

    // 2. Link markets in the window that aren't linked yet
    const r = await pool.query<{ platform: string; market_ticker: string; event_ticker: string }>(
      `SELECT platform, market_ticker, event_ticker FROM markets
        WHERE league = $1 AND game_id IS NULL AND (close_time IS NULL OR close_time >= $2)`, [league, new Date(from - DAY)]);
    let linked = 0;
    const unmatched: string[] = [];
    for (const m of r.rows) {
      const game = matchGame(m.platform, league, m.market_ticker, m.event_ticker, near);
      if (!game) { unmatched.push(m.market_ticker); continue; }
      await pool.query('UPDATE markets SET game_id = $1 WHERE platform = $2 AND market_ticker = $3',
        [`espn:${game.espnId}`, m.platform, m.market_ticker]);
      linked++;
    }
    log(`[Games] ${league}: linked ${linked}/${r.rows.length} markets` +
        (unmatched.length ? `; unmatched e.g. ${unmatched.slice(0, 6).join(', ')}` : ''));
  }
} finally {
  await pool.end();
}
