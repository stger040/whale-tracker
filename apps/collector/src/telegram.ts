/**
 * Telegram alerts via @splashspybot: per-user fan-out + account linking.
 *
 * Subscribers = rows in user_alert_prefs with telegram_chat_id set (linked from the website's /account
 * page via t.me/splashspybot?start=<token>), each filtered by their own leagues, per-league min_usd,
 * platforms, max_price and live_only. The owner's TELEGRAM_CHAT_ID (SSM) keeps receiving alerts with the
 * env defaults below unless that chat is linked to an account (then the account's settings apply).
 *
 * Bot updates are read by long-polling getUpdates here — this process must be the ONLY getUpdates
 * consumer for the token (no webhook set, no second collector).
 *
 * Telegram limits: ~1 msg/s per chat, ~30 msg/s per bot. We send ≤1/s per chat and ≤25/s overall.
 */
import type pg from 'pg';
import type { League } from '@whale/core';
import type { WhaleOrder } from './db.js';

const DEFAULT_MIN_USD: Record<League, number> = { NFL: 50_000, NBA: 25_000, MLB: 25_000, ATP: 10_000, WTA: 10_000, PGA: 10_000 };
const SITE_URL = process.env.WHALE_SITE_URL ?? 'https://whale-tracker-ashen.vercel.app';
const SUBSCRIBER_REFRESH_MS = 60_000;
const GLOBAL_MIN_GAP_MS = 40;      // ≤ 25 msg/s overall
const PER_CHAT_MIN_GAP_MS = 1100;  // ≤ ~1 msg/s per chat

export interface MarketLabel {
  title: string | null;
  yesSubTitle: string | null;
  /** From the ESPN games table, when the market is linked (markets.game_id). */
  gameStart?: Date | null;
}

interface Subscriber {
  chatId: string;
  userId: string | null; // null = owner fallback from env
  leagues: string[];
  minUsd: Record<string, number>;
  maxPrice: number;
  platforms: string[];
  liveOnly: boolean;
}

export class TelegramAlerter {
  private readonly token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  private readonly ownerChatId = process.env.TELEGRAM_CHAT_ID ?? '';
  private subscribers: Subscriber[] = [];
  private queues = new Map<string, string[]>();
  private nextAllowed = new Map<string, number>();
  private pumping = false;
  private updateOffset = 0;
  sent = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly lookup: (platform: string, ticker: string) => Promise<MarketLabel | null>,
    private readonly log: (msg: string) => void,
  ) {
    if (!this.token) { log('[Telegram] disabled (TELEGRAM_BOT_TOKEN not set)'); return; }
    void this.refreshSubscribers();
    setInterval(() => void this.refreshSubscribers(), SUBSCRIBER_REFRESH_MS);
    void this.pollUpdates();
  }

  get enabled(): boolean {
    return Boolean(this.token);
  }

  get subscriberCount(): number {
    return this.subscribers.length;
  }

  // ── Fan-out ────────────────────────────────────────────────────────────────

  private ownerDefaults(): Subscriber {
    const minUsd: Record<string, number> = {};
    for (const [league, def] of Object.entries(DEFAULT_MIN_USD)) {
      const override = Number(process.env[`TELEGRAM_MIN_USD_${league}`]);
      minUsd[league] = Number.isFinite(override) && override > 0 ? override : def;
    }
    return {
      chatId: this.ownerChatId, userId: null, leagues: Object.keys(DEFAULT_MIN_USD), minUsd,
      maxPrice: Number(process.env.TELEGRAM_MAX_PRICE ?? 0.9), platforms: ['kalshi', 'pmus'], liveOnly: false,
    };
  }

  private async refreshSubscribers(): Promise<void> {
    try {
      const r = await this.pool.query<{
        user_id: string; telegram_chat_id: string; leagues: string[]; min_usd: Record<string, number>;
        max_price: string; platforms: string[]; live_only: boolean;
      }>(`SELECT user_id, telegram_chat_id, leagues, min_usd, max_price, platforms, live_only
            FROM user_alert_prefs WHERE telegram_chat_id IS NOT NULL`);
      const subs: Subscriber[] = r.rows.map(x => ({
        chatId: x.telegram_chat_id, userId: x.user_id, leagues: x.leagues, minUsd: x.min_usd,
        maxPrice: Number(x.max_price), platforms: x.platforms, liveOnly: x.live_only,
      }));
      if (this.ownerChatId && !subs.some(s => s.chatId === this.ownerChatId)) subs.push(this.ownerDefaults());
      this.subscribers = subs;
    } catch (err) {
      this.log(`[Telegram] subscriber refresh failed: ${err}`); // keep the previous list
    }
  }

  private matches(s: Subscriber, o: WhaleOrder, label: MarketLabel | null): boolean {
    if (!s.leagues.includes(o.league) || !s.platforms.includes(o.platform)) return false;
    if (o.notionalUsd < (s.minUsd[o.league] ?? DEFAULT_MIN_USD[o.league as League] ?? 25_000)) return false;
    if (o.vwapPrice > s.maxPrice) return false;
    if (s.liveOnly && !(label?.gameStart && o.firstTs >= label.gameStart)) return false;
    return true;
  }

  /** Called for every clustered whale order: matches each subscriber's settings and queues. */
  async consider(o: WhaleOrder): Promise<void> {
    if (!this.enabled) return;
    // Cheap pre-filter: nobody wants orders below the smallest threshold anyone set.
    const floor = Math.min(...this.subscribers.map(s => s.minUsd[o.league] ?? Infinity));
    if (!(o.notionalUsd >= floor)) return;
    const label = await this.lookup(o.platform, o.marketTicker).catch(() => null);
    const recipients = this.subscribers.filter(s => this.matches(s, o, label));
    if (!recipients.length) return;
    const text = formatAlert(o, label);
    for (const s of recipients) this.enqueue(s.chatId, text);
  }

  private enqueue(chatId: string, text: string): void {
    const q = this.queues.get(chatId) ?? [];
    if (q.length >= 50) q.shift(); // a backed-up chat drops its oldest alerts rather than growing forever
    q.push(text);
    this.queues.set(chatId, q);
    void this.pump();
  }

  /** Round-robin over chats, honoring per-chat and global pacing and 429 retry_after. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while ([...this.queues.values()].some(q => q.length)) {
        const now = Date.now();
        const ready = [...this.queues.entries()].find(([chat, q]) => q.length && (this.nextAllowed.get(chat) ?? 0) <= now);
        if (!ready) { await sleep(100); continue; }
        const [chatId, q] = ready;
        const result = await this.send(chatId, q[0]);
        if (result === 'retry') continue;
        q.shift();
        if (result === 'ok') this.sent++;
        this.nextAllowed.set(chatId, Date.now() + PER_CHAT_MIN_GAP_MS);
        await sleep(GLOBAL_MIN_GAP_MS);
      }
    } finally {
      this.pumping = false;
    }
  }

  private async send(chatId: string, text: string): Promise<'ok' | 'drop' | 'retry'> {
    const r = await this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
    if (!r) { await sleep(5000); return 'retry'; }
    if (r.ok) return 'ok';
    if (r.status === 429) {
      const body = (await r.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      this.nextAllowed.set(chatId, Date.now() + (body.parameters?.retry_after ?? 5) * 1000);
      return 'retry';
    }
    const detail = (await r.text()).slice(0, 200);
    if (r.status === 403) {
      // User blocked the bot or deleted the chat: unlink so we stop trying.
      await this.pool.query('UPDATE user_alert_prefs SET telegram_chat_id = NULL, updated_at = now() WHERE telegram_chat_id = $1', [chatId])
        .catch(() => {});
      this.log(`[Telegram] chat ${chatId} blocked the bot — unlinked`);
    } else {
      this.log(`[Telegram] HTTP ${r.status} for chat ${chatId}: ${detail}`);
    }
    return 'drop';
  }

  private api(method: string, body: unknown, timeoutMs = 15_000): Promise<Response | null> {
    return fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch(err => { this.log(`[Telegram] ${method} network: ${err}`); return null; });
  }

  // ── Bot: account linking (/start <token>, /stop) ──────────────────────────

  private async pollUpdates(): Promise<void> {
    for (;;) {
      const r = await this.api('getUpdates', { offset: this.updateOffset, timeout: 50, allowed_updates: ['message'] }, 65_000);
      if (!r?.ok) { await sleep(5000); continue; }
      const body = (await r.json()) as { result?: TgUpdate[] };
      for (const u of body.result ?? []) {
        this.updateOffset = u.update_id + 1;
        if (u.message?.text && u.message.chat?.type === 'private') {
          await this.handleCommand(String(u.message.chat.id), u.message.text.trim()).catch(err => this.log(`[Telegram] command: ${err}`));
        }
      }
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<void> {
    const [cmd, arg] = text.split(/\s+/, 2);
    if (cmd === '/start' && arg) {
      const r = await this.pool.query<{ user_id: string }>(
        `DELETE FROM telegram_link_tokens WHERE token = $1 AND expires_at > now() RETURNING user_id`, [arg]);
      const userId = r.rows[0]?.user_id;
      if (!userId) {
        await this.reply(chatId, `That link has expired. Open ${SITE_URL}/account and tap “Connect Telegram” again.`);
        return;
      }
      // One chat ↔ one account: detach this chat from any other account first.
      await this.pool.query('UPDATE user_alert_prefs SET telegram_chat_id = NULL, updated_at = now() WHERE telegram_chat_id = $1 AND user_id <> $2', [chatId, userId]);
      await this.pool.query(
        `INSERT INTO user_alert_prefs (user_id, telegram_chat_id) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET telegram_chat_id = EXCLUDED.telegram_chat_id, updated_at = now()`,
        [userId, chatId]);
      await this.refreshSubscribers();
      this.log(`[Telegram] linked chat ${chatId} to user ${userId}`);
      await this.reply(chatId, `✅ Connected. Whale alerts matching your settings will arrive here.\nChange them any time: ${SITE_URL}/account\nSend /stop to disconnect.`);
    } else if (cmd === '/start') {
      await this.reply(chatId, `👋 $PLASHSPY sends real-time alerts when big money hits NBA and NFL markets on Kalshi and Polymarket US.\nSign up and connect this chat at ${SITE_URL}/account`);
    } else if (cmd === '/stop') {
      const r = await this.pool.query('UPDATE user_alert_prefs SET telegram_chat_id = NULL, updated_at = now() WHERE telegram_chat_id = $1', [chatId]);
      await this.refreshSubscribers();
      await this.reply(chatId, r.rowCount ? '🔕 Disconnected — no more alerts here. Reconnect from your account page any time.' : 'This chat isn’t connected to an account.');
    } else {
      await this.reply(chatId, `Manage your alerts at ${SITE_URL}/account · /stop to disconnect.`);
    }
  }

  private async reply(chatId: string, text: string): Promise<void> {
    await this.api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  }
}

interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat?: { id: number; type: string } };
}

export function formatAlert(o: WhaleOrder, label: MarketLabel | null): string {
  const platform = o.platform === 'kalshi' ? 'Kalshi' : 'Polymarket US';
  const team = label?.yesSubTitle ?? o.marketTicker;
  // Kalshi game markets are per team: NO on "Knicks" = betting against the Knicks.
  const pick = o.takerSide === 'yes' ? `${team} to win` : `Against ${team}`;
  const cents = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}¢`;
  const priceRange = o.minPrice === o.maxPrice ? cents(o.vwapPrice) : `${cents(o.vwapPrice)} avg (${cents(o.minPrice)}–${cents(o.maxPrice)})`;
  const multiple = o.notionalUsd > 0 ? o.contracts / o.notionalUsd : 0;
  const when = o.firstTs.toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  const intent = o.takerIntent?.includes('SELL_') ? '\n⚠️ Closing an existing position' : '';
  const phase = label?.gameStart ? (o.firstTs < label.gameStart ? ' · pre-game' : ' · 🔴 live') : '';
  return [
    `🐋 <b>${esc(o.league)} · ${platform}</b>`,
    `<b>${esc(pick)}</b> — ${usd(o.notionalUsd)} @ ${priceRange}`,
    `Pays ${usd(o.contracts)} if right (${multiple.toFixed(2)}x)`,
    label?.title ? `<i>${esc(label.title)}</i>` : '',
    `${o.fills} fill${o.fills === 1 ? '' : 's'} · ${when} CT${phase}${intent}`,
  ].filter(Boolean).join('\n');
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
