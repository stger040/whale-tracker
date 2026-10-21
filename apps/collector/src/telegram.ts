/**
 * Owner-only Telegram alerts (step 3). Per-user thresholds and channels come later with the website.
 *
 * Env: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (both from SSM /whale-tracker/*). Disabled if either is missing.
 * Thresholds: TELEGRAM_MIN_USD_<LEAGUE> overrides DEFAULT_MIN_USD; orders priced above
 * TELEGRAM_MAX_PRICE (default 0.90) are skipped — those are mostly late-game near-locks.
 *
 * Defaults chosen from backfilled Kalshi fills (2026-10-21): fills ≥$25k at ≤90¢ average
 * ~2.6/game NBA, ~2.3 MLB, ~9.7 NFL; ≥$50k ~1.5/game NFL.
 */
import type { League } from '@whale/core';
import type { WhaleOrder } from './db.js';

const DEFAULT_MIN_USD: Record<League, number> = { NFL: 50_000, NBA: 25_000, MLB: 25_000, ATP: 10_000, WTA: 10_000, PGA: 10_000 };

export interface MarketLabel {
  title: string | null;
  yesSubTitle: string | null;
}

export class TelegramAlerter {
  private readonly token = process.env.TELEGRAM_BOT_TOKEN ?? '';
  private readonly chatId = process.env.TELEGRAM_CHAT_ID ?? '';
  private readonly maxPrice = Number(process.env.TELEGRAM_MAX_PRICE ?? 0.9);
  private queue: string[] = [];
  private sending = false;
  sent = 0;

  constructor(
    private readonly lookup: (platform: string, ticker: string) => Promise<MarketLabel | null>,
    private readonly log: (msg: string) => void,
  ) {
    if (!this.enabled) log('[Telegram] disabled (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set)');
  }

  get enabled(): boolean {
    return Boolean(this.token && this.chatId);
  }

  minUsd(league: string): number {
    const override = Number(process.env[`TELEGRAM_MIN_USD_${league}`]);
    return Number.isFinite(override) && override > 0 ? override : DEFAULT_MIN_USD[league as League] ?? 25_000;
  }

  /** Called for every clustered whale order; filters, formats and queues. */
  async consider(o: WhaleOrder): Promise<void> {
    if (!this.enabled || o.notionalUsd < this.minUsd(o.league) || o.vwapPrice > this.maxPrice) return;
    const label = await this.lookup(o.platform, o.marketTicker).catch(() => null);
    this.queue.push(formatAlert(o, label));
    void this.drain();
  }

  async sendText(text: string): Promise<void> {
    if (!this.enabled) return;
    this.queue.push(text);
    await this.drain();
  }

  /** One message per second (Telegram's per-chat limit); honors 429 retry_after. */
  private async drain(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const text = this.queue[0];
        const r = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: AbortSignal.timeout(15_000),
        }).catch(err => { this.log(`[Telegram] network: ${err}`); return null; });
        if (r?.ok) {
          this.queue.shift();
          this.sent++;
        } else if (r?.status === 429) {
          const body = (await r.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
          await sleep((body.parameters?.retry_after ?? 5) * 1000);
          continue;
        } else if (r) {
          // 4xx other than 429 won't succeed on retry (bad chat id, bad markup) — drop it.
          this.log(`[Telegram] HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
          this.queue.shift();
        } else {
          await sleep(5000);
          continue;
        }
        await sleep(1100);
      }
    } finally {
      this.sending = false;
    }
  }
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
  return [
    `🐋 <b>${esc(o.league)} · ${platform}</b>`,
    `<b>${esc(pick)}</b> — ${usd(o.notionalUsd)} @ ${priceRange}`,
    `Pays ${usd(o.contracts)} if right (${multiple.toFixed(2)}x)`,
    label?.title ? `<i>${esc(label.title)}</i>` : '',
    `${o.fills} fill${o.fills === 1 ? '' : 's'} · ${when} CT${intent}`,
  ].filter(Boolean).join('\n');
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
