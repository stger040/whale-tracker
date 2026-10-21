/**
 * ESPN public scoreboard — authoritative game start times and final scores (no key needed).
 *   https://site.api.espn.com/apis/site/v2/sports/{basketball/nba|football/nfl}/scoreboard?dates=YYYYMMDD
 * `dates` is the US (Eastern) schedule date. Kalshi's occurrence/expected_expiration fields are
 * projected game END times, not starts — don't use them for tip-off (checked 2026-10-21).
 *
 * Team codes differ by source; everything is normalized to ESPN abbreviations here.
 */
import type { League } from './types.js';

const ESPN_PATH: Partial<Record<League, string>> = { NBA: 'basketball/nba', NFL: 'football/nfl' };

export interface EspnGame {
  league: League;
  espnId: string;
  startTime: Date;
  awayAbbr: string; // ESPN abbreviation
  homeAbbr: string;
  awayName: string;
  homeName: string;
  status: string; // STATUS_SCHEDULED | STATUS_IN_PROGRESS | STATUS_FINAL | ...
  awayScore: number | null;
  homeScore: number | null;
}

/** Kalshi/PM.US code → ESPN abbreviation, where they differ. Same code in both = identity. */
const TO_ESPN: Record<'NBA' | 'NFL', Record<string, string>> = {
  NBA: { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH', PHO: 'PHX' },
  NFL: { JAC: 'JAX', WAS: 'WSH', LA: 'LAR' },
};

export function toEspnAbbr(league: League, code: string): string {
  const c = code.toUpperCase();
  return (TO_ESPN as Record<string, Record<string, string>>)[league]?.[c] ?? c;
}

export function espnSupports(league: League): boolean {
  return league in ESPN_PATH;
}

export async function fetchEspnScoreboard(league: League, yyyymmdd: string): Promise<EspnGame[]> {
  const path = ESPN_PATH[league];
  if (!path) return [];
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${yyyymmdd}&limit=100`,
    { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`ESPN ${league} ${yyyymmdd}: HTTP ${r.status}`);
  const d = (await r.json()) as { events?: EspnEvent[] };
  const out: EspnGame[] = [];
  for (const e of d.events ?? []) {
    const c = e.competitions?.[0];
    const home = c?.competitors?.find(x => x.homeAway === 'home');
    const away = c?.competitors?.find(x => x.homeAway === 'away');
    // All-Star / TBD playoff slots come without real team abbreviations — not tradable game markets.
    if (!c || !home?.team?.abbreviation || !away?.team?.abbreviation) continue;
    const final = c.status?.type?.completed;
    out.push({
      league,
      espnId: e.id,
      startTime: new Date(e.date),
      awayAbbr: away.team.abbreviation,
      homeAbbr: home.team.abbreviation,
      awayName: away.team.displayName,
      homeName: home.team.displayName,
      status: c.status?.type?.name ?? 'UNKNOWN',
      awayScore: final ? Number(away.score) : null,
      homeScore: final ? Number(home.score) : null,
    });
  }
  return out;
}

interface EspnEvent {
  id: string;
  date: string;
  competitions?: {
    status?: { type?: { name?: string; completed?: boolean } };
    competitors?: { homeAway: 'home' | 'away'; score?: string; team: { abbreviation: string; displayName: string } }[];
  }[];
}

/** UTC calendar date as YYYYMMDD. */
export function yyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * Parses a Kalshi game event ticker, e.g. KXNBAGAME-26OCT20PHINYK → { date: 2026-10-20, teams: 'PHINYK' }.
 * The team part is away+home concatenated with no separator (codes are 2–3 letters).
 */
export function parseKalshiGameEvent(eventTicker: string): { date: Date; teams: string } | null {
  const m = /^[A-Z]+-(\d{2})([A-Z]{3})(\d{2})(?:\d{4})?([A-Z]+)$/.exec(eventTicker);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]);
  if (month < 0) return null;
  return { date: new Date(Date.UTC(2000 + Number(m[1]), month, Number(m[3]))), teams: m[4] };
}

/** True if a Kalshi team blob ("PHINYK") is exactly away+home for this game, in any known spelling. */
export function kalshiTeamsMatch(g: EspnGame, teams: string): boolean {
  const variants = (abbr: string) => {
    const v = new Set([abbr]);
    for (const [code, espn] of Object.entries(TO_ESPN[g.league as 'NBA' | 'NFL'] ?? {})) if (espn === abbr) v.add(code);
    return [...v];
  };
  for (const a of variants(g.awayAbbr)) for (const h of variants(g.homeAbbr)) if (a + h === teams) return true;
  return false;
}

/** PM.US aec slug, e.g. aec-nba-pho-por-2026-10-21 → { date, codes: ['PHX','POR'] } (ESPN abbreviations). */
export function parsePmusGameSlug(league: League, slug: string): { date: Date; codes: [string, string] } | null {
  const m = /^aec-[a-z]+-([a-z]+)-([a-z]+)-(\d{4})-(\d{2})-(\d{2})$/.exec(slug);
  if (!m) return null;
  return {
    date: new Date(Date.UTC(Number(m[3]), Number(m[4]) - 1, Number(m[5]))),
    codes: [toEspnAbbr(league, m[1]), toEspnAbbr(league, m[2])],
  };
}
