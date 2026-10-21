import type { League } from './types.js';

/**
 * Kalshi series that carry single-game winner markets for each league.
 * Earliest settled events (checked 2026-10-20): NBA/MLB Apr 2025, NFL Jul 2025,
 * ATP/WTA Jun 2025, PGA 2025.
 */
export const KALSHI_SERIES: Record<League, string[]> = {
  NFL: ['KXNFLGAME'],
  NBA: ['KXNBAGAME'],
  MLB: ['KXMLBGAME'],
  ATP: ['KXATPMATCH'],
  WTA: ['KXWTAMATCH'],
  PGA: ['KXPGATOUR'],
};

export const ALL_LEAGUES = Object.keys(KALSHI_SERIES) as League[];

export function parseLeagues(arg: string | undefined): League[] {
  if (!arg) return ALL_LEAGUES;
  const wanted = arg.split(',').map(s => s.trim().toUpperCase());
  const bad = wanted.filter(l => !(l in KALSHI_SERIES));
  if (bad.length) throw new Error(`Unknown league(s): ${bad.join(', ')}. Valid: ${ALL_LEAGUES.join(', ')}`);
  return wanted as League[];
}
