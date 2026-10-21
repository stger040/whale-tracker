# Whale Tracker — AI Session Context

Detects large ("whale") trades on **Kalshi** and **Polymarket US (PM.US)** sports markets and alerts
subscribers. Read this before touching code. Sister project: `stger040/prediction-markets`
(ArbScout arbitrage bot) — its CLAUDE.md is the source for the confirmed API facts copied below.

**This app never places orders.** Do not add order-placement code. The shared cloud environment has
`AUTO_TRADE=true` / `KALSHI_USE_PROD=true` set for ArbScout; nothing here reads them.

---

## Product

- **Sports only**: NFL, NBA, MLB, tennis (ATP/WTA), golf (PGA).
- **Users choose their own whale threshold**; defaults per league come from the historical data.
- **Alerts**: Telegram + Discord first, then email (SES), web push, SMS (SNS, needs US carrier
  registration — start early).
- **Paid tiers via Stripe** (Free / Pro / Whale — see Roadmap). Test mode until the data-licensing
  check below is done.
- Kalshi and PM.US feeds are **anonymous** — we can flag "someone bought $250k of YES", never *who*.

**Open legal item before charging**: confirm Kalshi's and PM.US's developer / market-data terms
allow commercial redistribution of trade data in alerts.

---

## Architecture

```
Kalshi WS/REST ─┐                          ┌─> Telegram / Discord / email / SMS / web push
PM.US WS ───────┼─> apps/collector (AWS EC2, always on: WebSockets + alert fan-out)
                │            │
                │            ▼
                │       Neon Postgres  <──  apps/web (Vercel, Next.js: auth, settings, feed, billing)
                │                                   │
                └───────────────────────────  Stripe (Checkout, Customer Portal, webhooks)
```

Vercel can't hold long-lived WebSockets, so the collector lives on EC2; everything user-facing is on Vercel.

| Path | What |
|---|---|
| `packages/core` | Shared types, league→series config, `NotionalHistogram`, Kalshi REST client |
| `apps/collector` | Backfill + (next) live collector and alert sender. Runs with `tsx` |
| `apps/web` | (not yet) Next.js site |
| `db/schema.sql` | Idempotent schema — apply with `npm run db:migrate` |

npm workspaces; Node ≥ 20; TypeScript run directly with `tsx` (no build step for the collector).

---

## Data model (`db/schema.sql`)

- `markets` — one row per platform market; `backfilled_at` marks a fully processed market (resume key).
- `trades` — individual trades with `notional_usd ≥ MIN_STORE_USD` (default $500).
  `notional_usd = contracts × taker_price`, where `taker_price` is what the taker paid for the side
  they bought (`yes_price` if `taker_side='yes'`, else `no_price`).
- `market_trade_stats` — per-market histogram over **all** trades (no floor): fixed USD buckets
  (`BUCKET_EDGES_USD` in `packages/core/src/histogram.ts`) + exact p50/p90/p99/p99.9/max.
  Sum `bucket_counts` across markets for league-wide distributions.

Rules carried over from ArbScout:
- **DDL only through the `pg` Pool**, never the `neon()` HTTP client (DDL via the pooler can silently not commit).
- **No SMALLINT for sizes** — contract counts and PM.US depth run to 6–7 digits. Use NUMERIC.

---

## Kalshi — confirmed facts

| | |
|---|---|
| REST | `https://external-api.kalshi.com/trade-api/v2` |
| WS | `wss://external-api-ws.kalshi.com/trade-api/ws/v2` (auth: RSA-PSS SHA256 headers `KALSHI-ACCESS-KEY/-TIMESTAMP/-SIGNATURE`, see ArbScout `matcher/lib/ws-kalshi.ts`) |
| Trade tape | `GET /markets/trades?ticker=&limit=1000&cursor=` — **public, no auth** |
| Historical split | `GET /historical/cutoff` → `trades_created_ts` (was 2026-08-21). Older trades are ONLY in `/historical/trades`; older settled markets ONLY in `/historical/markets`. Query both and dedupe by `trade_id` (done in `KalshiRestClient.marketTrades`). |
| Events | `GET /events?series_ticker=&limit=200` lists live + settled events back to series start |
| Rate limit (unauth) | Low. 429 `too_many_requests`, **no Retry-After**. ~8 req/s target → ~4 req/s effective with ~9% retries. Client backs off exponentially. |

Trade fields: `trade_id, ticker, created_time, count_fp, yes_price_dollars, no_price_dollars,
taker_side, taker_outcome_side, taker_book_side, is_block_trade`. Market fields used: `ticker,
event_ticker, title, yes_sub_title, open_time, close_time, result, status`.

Sports series and history depth (checked 2026-10-20):

| League | Series | Events | Earliest |
|---|---|---|---|
| NFL | `KXNFLGAME` | 502 | 2025-07-31 |
| NBA | `KXNBAGAME` | 1,567 | 2025-04-15 |
| MLB | `KXMLBGAME` | 4,683 | 2025-04-16 |
| ATP / WTA | `KXATPMATCH` / `KXWTAMATCH` | ~5,000 each | 2025-06-18 |
| PGA | `KXPGATOUR` | 78 | 2025 (one market per golfer) |

Game series have 2 markets per event (one per team).

## PM.US — confirmed facts

- Public gateway `https://gateway.polymarket.us` (no auth); authenticated API `https://api.polymarket.us`.
- Auth: Ed25519 over `{timestampMs}{METHOD}{path}`, headers `X-PM-Access-Key`, `X-PM-Timestamp`,
  `X-PM-Signature`. Key = base64; if 64 bytes use first 32 as seed; PKCS8 DER prefix
  `302e020100300506032b657004220420`. Env: `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY`.
- WS `wss://api.polymarket.us/v1/ws/markets`. **Trade stream**: subscribe
  `SUBSCRIPTION_TYPE_TRADE` → `{ trade: { marketSlug, price:{value,currency}, quantity:{value,currency},
  tradeTime, maker:{side,intent}, taker:{side,intent} } }` (from official SDK
  `github.com/Polymarket/polymarket-us-typescript`, `src/websocket/types.ts`).
- `MARKET_DATA` frames: `px` is a nested `{value, currency}` object; `qty` is a **string**, often millions.
- **No historical trades endpoint.** `/v1/markets/{slug}/trades`, `/v1/trades`, `/history` → 404;
  settled markets expose only `outcomePrices`. PM.US history = whatever we record from the live stream.
- Binary sports markets use `aec-{league}-{away}-{home}-{date}` slugs (single slug per game).
- `GET /v1/market/slug/{slug}` (gateway) returns market metadata incl. `feeCoefficient` (0.0695 seen).
- Event discovery: `category=NFL` returns 0 — use `live=true` with no category and match titles.

---

## Observed trade sizes (dry run 2026-10-20, 2 NFL games, 4 markets, 668k trades, $62M)

Per-market p99 ≈ $1.0–1.9k, p99.9 ≈ $7–11k, max $96k–$248k. Trades ≥ $10k: 521; ≥ $25k: 131; ≥ $50k: 31.
→ A $10k NFL threshold would fire ~130 alerts per market per game — too noisy for a default.
NBA (Apr 2026 single game): p99 ≈ $10k, max ≈ $70k. Thresholds must be per league.

Large taker orders that sweep several price levels show up as **multiple fills** — the alert logic
should cluster same-market, same-side fills within a short window into one "whale order".

---

## Infrastructure

| Piece | Where | Status |
|---|---|---|
| Neon DB | Vercel-managed Neon org — create projects from **Vercel → Storage**, not neon.tech | Not created yet |
| Website | Vercel project `whale-tracker` (currently in the Hobby team) | Empty, no Git link |
| Collector | AWS EC2 us-east-1 (separate from ArbScout's DELTIX instance) | Not provisioned |
| Payments | Stripe (already installed as a Vercel integration on the SG Enterprises team) | Not wired |

**Vercel Hobby is non-commercial.** Paid customers require the project to live on a Pro team
(SG Enterprises). Neon on the Hobby team is the Free plan (0.5 GB/project) — too small for the backfill.

User is in Minnesota: launch scripts with `TZ=America/Chicago`; keep all date math in UTC.

---

## Commands

```bash
npm install
cp .env.example .env            # fill DATABASE_URL
npm run db:migrate
npm run backfill:kalshi -- --leagues NFL --max-events 2 --dry-run   # no DB, prints stats
TZ=America/Chicago npm run backfill:kalshi -- --leagues NFL,NBA,MLB # full, resumable
npm run typecheck
```

---

## Roadmap

1. ✅ Repo scaffold, schema, Kalshi backfill (dry-run verified live)
2. ⏳ Run full Kalshi backfill into Neon (needs DB)
3. Live collector: Kalshi + PM.US trade streams on EC2; Telegram alerts to the owner only
4. Size report → default thresholds per league and tier boundaries
5. `apps/web` on Vercel: auth (Clerk), alert settings, whale feed
6. Stripe: products/prices per tier, Checkout, Customer Portal, webhooks → `subscriptions` table
7. Channels: Discord, email, web push, SMS

Tier sketch (finalize from data): **Free** — delayed/digest, 1 league, email, fixed high threshold ·
**Pro ~$19/mo** — real-time, all leagues, custom thresholds, Telegram/Discord/email/push ·
**Whale ~$49/mo** — + SMS, per-team/market filters, flow summaries, full history/export, API.
