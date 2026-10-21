import type pg from 'pg';
import { kalshiTeamsMatch, parseKalshiGameEvent, parsePmusGameSlug, type EspnGame, type League } from '@whale/core';

const DAY = 86_400_000;

/** Finds the ESPN game for a Kalshi/PM.US market among candidates (± 1 day of the ticker/slug date). */
export function matchGame(platform: string, league: League, marketTicker: string, eventTicker: string,
  candidates: (date: Date) => EspnGame[]): EspnGame | undefined {
  if (platform === 'kalshi') {
    const p = parseKalshiGameEvent(eventTicker);
    return p ? candidates(p.date).find(g => kalshiTeamsMatch(g, p.teams)) : undefined;
  }
  const p = parsePmusGameSlug(league, marketTicker);
  return p ? candidates(p.date).find(g => p.codes.includes(g.awayAbbr) && p.codes.includes(g.homeAbbr)) : undefined;
}

/** Live path: link one newly seen market using games already in the DB (synced 7 days ahead daily). */
export async function linkMarketFromDb(pool: pg.Pool, platform: string, league: League,
  marketTicker: string, eventTicker: string): Promise<boolean> {
  const date = platform === 'kalshi' ? parseKalshiGameEvent(eventTicker)?.date : parsePmusGameSlug(league, marketTicker)?.date;
  if (!date) return false;
  const r = await pool.query<{ game_id: string; start_time: Date; away_abbr: string; home_abbr: string }>(
    `SELECT game_id, start_time, away_abbr, home_abbr FROM games
      WHERE league = $1 AND start_time BETWEEN $2 AND $3`,
    [league, new Date(date.getTime() - DAY), new Date(date.getTime() + 2 * DAY)]);
  const games: EspnGame[] = r.rows.map(g => ({
    league, espnId: g.game_id.replace(/^espn:/, ''), startTime: g.start_time, awayAbbr: g.away_abbr, homeAbbr: g.home_abbr,
    awayName: '', homeName: '', status: '', awayScore: null, homeScore: null,
  }));
  const game = matchGame(platform, league, marketTicker, eventTicker, () => games);
  if (!game) return false;
  await pool.query('UPDATE markets SET game_id = $1 WHERE platform = $2 AND market_ticker = $3',
    [`espn:${game.espnId}`, platform, marketTicker]);
  return true;
}
