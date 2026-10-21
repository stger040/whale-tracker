import 'server-only';
import { neon } from '@neondatabase/serverless';

/**
 * Writes go through role `whale_app` (SELECT on feed tables, SELECT/INSERT/UPDATE on user_alert_prefs only).
 * Kept separate from the read-only `whale_reader` used for the public feed.
 */
function appSql() {
  const url = process.env.WHALE_APP_DATABASE_URL;
  if (!url) throw new Error('WHALE_APP_DATABASE_URL is not set');
  return neon(url);
}

export const LEAGUES = ['NBA', 'NFL'] as const;
export type League = (typeof LEAGUES)[number];

export interface AlertPrefs {
  leagues: League[];
  minUsd: Record<League, number>;
  maxPrice: number;
  platforms: ('kalshi' | 'pmus')[];
  liveOnly: boolean;
  tier: string;
  telegramLinked: boolean;
}

export const DEFAULT_PREFS: AlertPrefs = {
  leagues: ['NBA', 'NFL'],
  minUsd: { NBA: 25_000, NFL: 50_000 },
  maxPrice: 0.9,
  platforms: ['kalshi', 'pmus'],
  liveOnly: false,
  tier: 'free',
  telegramLinked: false,
};

export async function getPrefs(userId: string): Promise<AlertPrefs> {
  const rows = await appSql()`
    SELECT leagues, min_usd, max_price, platforms, live_only, tier, telegram_chat_id IS NOT NULL AS tg
    FROM user_alert_prefs WHERE user_id = ${userId}`;
  const r = rows[0];
  if (!r) return DEFAULT_PREFS;
  return {
    leagues: r.leagues,
    minUsd: { ...DEFAULT_PREFS.minUsd, ...r.min_usd },
    maxPrice: Number(r.max_price),
    platforms: r.platforms,
    liveOnly: r.live_only,
    tier: r.tier,
    telegramLinked: r.tg,
  };
}

export async function savePrefs(userId: string, email: string, p: Omit<AlertPrefs, 'tier' | 'telegramLinked'>) {
  await appSql()`
    INSERT INTO user_alert_prefs (user_id, email, leagues, min_usd, max_price, platforms, live_only)
    VALUES (${userId}, ${email}, ${p.leagues}, ${JSON.stringify(p.minUsd)}::jsonb, ${p.maxPrice}, ${p.platforms}, ${p.liveOnly})
    ON CONFLICT (user_id) DO UPDATE SET
      email = EXCLUDED.email, leagues = EXCLUDED.leagues, min_usd = EXCLUDED.min_usd,
      max_price = EXCLUDED.max_price, platforms = EXCLUDED.platforms, live_only = EXCLUDED.live_only,
      updated_at = now()`;
}

export const TELEGRAM_BOT = 'splashspybot';

/** Creates a 15-minute one-time code; the collector's bot links the chat on "/start <code>". */
export async function createTelegramLinkToken(userId: string): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const token = Buffer.from(bytes).toString('base64url'); // 32 chars of [A-Za-z0-9_-], valid as a start param
  await appSql()`
    INSERT INTO telegram_link_tokens (token, user_id, expires_at)
    VALUES (${token}, ${userId}, now() + interval '15 minutes')`;
  return token;
}

export async function unlinkTelegram(userId: string): Promise<void> {
  await appSql()`UPDATE user_alert_prefs SET telegram_chat_id = NULL, updated_at = now() WHERE user_id = ${userId}`;
}
