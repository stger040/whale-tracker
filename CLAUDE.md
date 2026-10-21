# Whale Tracker — AI Session Context

Detects large ("whale") trades on **Kalshi** and **Polymarket US (PM.US)** sports markets and alerts
subscribers. Read this before touching code. Sister project: `stger040/prediction-markets`
(ArbScout arbitrage bot) — its CLAUDE.md is the source for the confirmed API facts copied below.

**This app never places orders.** Do not add order-placement code. The shared cloud environment has
`AUTO_TRADE=true` / `KALSHI_USE_PROD=true` set for ArbScout; nothing here reads them.

> **⚠️ Open security item (2026-10-21):** fragments of the Kalshi RSA private key were printed into a
> Claude session transcript while debugging the EC2 env file. The owner chose to rotate it on their planned
> schedule (~2026-10-28) — it is shared with ArbScout (DELTIX `.env`, cloud env). After rotation, update
> `/whale-tracker/KALSHI_API_KEY_ID` + `/whale-tracker/KALSHI_PRIVATE_KEY` and run the rotation procedure below.

---

## Product

- **Sports only**: NFL, NBA, MLB, tennis (ATP/WTA), golf (PGA). **Current focus (2026-10-21): NBA + NFL only**
  — `WHALE_LEAGUES=NBA,NFL` on EC2 limits live collection, backfill, daily catch-up and alerts. Other
  leagues' code stays; data already collected (MLB ~350 games) stays in the DB. Unset to re-enable all.
- **Users choose their own whale threshold**; defaults per league come from the historical data.
- **Alerts**: Telegram + Discord first, then email (SES), web push, SMS (SNS, needs US carrier
  registration — start early).
- **Paid tiers via Stripe** (Free / Pro / Whale — see Roadmap). **On hold (2026-10-21):** owner is getting
  an EIN + business bank account for this company first. The Stripe integration already installed on the
  Vercel SG Enterprises team belongs to an **unrelated healthcare company — never connect it to whale-tracker.**
  Test mode until the data-licensing check below is done.
- **Accounts: Neon Auth** (managed Better Auth, email/password; users in `neon_auth."user"`), chosen
  2026-10-21 over Clerk. `/auth/sign-in`, `/auth/sign-up`, protected `/account` (alert settings →
  `user_alert_prefs`). `apps/web/lib/auth/server.ts`; `proxy.ts` protects `/account`.
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
| `apps/collector` | `backfill-kalshi.ts` (history), `live.ts` (live streams → trades/stats/whale_orders), `clusterer.ts`. Runs with `tsx` |
| `apps/web` | Next.js 16 + Tailwind 4 site: public whale feed (reads `whale_orders` ⋈ `markets` ⋈ `games`). Vercel project `whale-tracker` (SG Enterprises) |
| `analysis/` | SQL studies: `whale-outcomes.sql`, `price-impact.sql` (run with `npm run sql -- <file>`) |
| `db/schema.sql` | Idempotent schema — apply with `npm run db:migrate` |

npm workspaces; Node ≥ 20; TypeScript run directly with `tsx` (no build step for the collector).

---

## Data model (`db/schema.sql`)

- `markets` — one row per platform market; `backfilled_at` marks a fully processed market (resume key).
- `trades` — individual trades with `notional_usd ≥ MIN_STORE_USD` (default $500).
  `notional_usd = contracts × taker_price`, where `taker_price` is what the taker paid for the side
  they bought (`yes_price` if `taker_side='yes'`, else `no_price`).
- `whale_orders` — fills clustered into taker orders (same market + side, ≤ `CLUSTER_GAP_MS` apart,
  default 1500 ms), logged when ≥ `WHALE_LOG_MIN_USD` (default $5k). Includes VWAP, min/max price,
  `potential_payout_usd` (= contracts) and PM.US `taker_intent`. **This is the feed for alerts/website.**
- `games` — ESPN schedule/results (`game_id = 'espn:<id>'`, exact `start_time`, scores) for NBA/NFL;
  `markets.game_id` links Kalshi + PM.US markets (`sync-games.ts`, daily −3d…+7d; the live collector links
  new markets on first sight via `link-games.ts`). **Kalshi's occurrence/expected_expiration fields are
  projected game END times — use `games.start_time` for pre-game vs in-game.**
  Team-code aliases (ESPN ↔ Kalshi/PM.US) live in `packages/core/src/espn.ts`.
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

**Live WS (confirmed 2026-10-21)**: subscribe `{cmd:'subscribe', params:{channels:['trade']}}` with **no
market_tickers** → every trade on the exchange (~160/s; crypto 15-min markets dominate). Frame fields match
the REST tape plus `ts_ms`. Filter by series prefix. Tennis also has `KXATPCHALLENGERMATCH`, `KXITFMATCH`,
`KXITFWMATCH` (not yet included).

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
- **All-markets trade stream**: `SUBSCRIPTION_TYPE_TRADE` with `marketSlugs: []` streams every trade.
  `price` = YES price; `quantity` = contracts; `taker.side` BUY → YES exposure, SELL → NO exposure;
  `taker.intent` BUY_LONG/BUY_SHORT = opening, SELL_LONG/SELL_SHORT = closing (sometimes UNDEFINED).
  `id` = trade id; `tradeTime` has ns precision. Parsed in `packages/core/src/pmus.ts`.
- **No historical trades endpoint.** `/v1/markets/{slug}/trades`, `/v1/trades`, `/history` → 404;
  settled markets expose only `outcomePrices`. PM.US history = whatever we record from the live stream.
- Binary sports markets use `aec-{league}-{away}-{home}-{date}` slugs (single slug per game).
- `GET /v1/market/slug/{slug}` (gateway) returns market metadata incl. `feeCoefficient` (0.0695 seen).
- Event discovery: `category=NFL` returns 0 — use `live=true` with no category and match titles.

---

## Observed trade sizes (dry run 2026-10-20, 2 NFL games, 4 markets, 668k trades, $62M)

Per-market p99 ≈ $1.0–1.9k, p99.9 ≈ $7–11k, max $96k–$248k. Trades ≥ $10k: 521; ≥ $25k: 131; ≥ $50k: 31.
→ A $10k NFL threshold would fire ~130 alerts per market per game — too noisy for a default.
NBA (Apr 2026 single game): p99 ≈ $10k, max ≈ $70k. NBA PHI@NYK 2026-10-20: 158k trades, $11.7M,
p99.9 ≈ $6.5–6.9k, max $82.5k. Thresholds must be per league.

Alert-design findings from the first stored data:
- Many of the biggest trades are **late-game buys at 90–99¢** (near-locked outcome) — low signal.
  The $82.5k NYK YES at 33¢ was the genuinely interesting one. Classify by price / payout, not just $.
- The two markets of a game are mirror images (PHI YES ≈ NYK NO) — aggregate per game for game-level views.

**Do whales win? (2026-10-21, Kalshi NFL/NBA/MLB, ~3.3M settled fills ≥$500 → orders; `analysis/whale-outcomes.sql`)**
No robust edge. At every order size ($1k → $100k+) the whale side wins ~1–1.7 pts *less* often than its
price implied (within ±2–3 pt CI): big money is about as well-calibrated as the market, not better.
Big underdog orders (<45¢) looked like +5–8 pts per order, but with one vote per game the edge is −0.3 ±3.9
pts — the effect was a few winning games with many piled-on orders. Dollar ROI on big underdog orders is
positive (+29%) but driven by a handful of 3–5x payouts. **Product implication:** sell alerts as "where the
big money is moving" (flow, size, line moves), never as "follow the whales to profit".
**Price impact + phase (2026-10-21, `analysis/price-impact.sql` → `analysis.order_impact`, Kalshi NBA/NFL,
orders ≤90¢; move = price of the whale's side 15 min after vs just before the order):**
- NBA **pre-game**: $25k+ orders +0.53¢ (±0.14), $10–25k +0.28¢ (±0.10), $1–5k control +0.04¢ (±0.08) —
  persistent, size-dependent drift toward the whale's side. NFL pre-game same shape, weaker (+0.30 ±0.29).
  In-game moves are dominated by game events (±1–2¢ CIs). Pre-game whales still don't win more than their
  price (NBA −1.8 ±3.1, NFL +0.1 ±5.0 pts): they move the line, the line is then fair.
- **In-game $25k+ orders ≤90¢ won more than priced** (one vote per game): NBA +4.4 ±2.9 pts (885 games),
  NFL +5.6 ±4.4 (398). Found after slicing many ways → treat as a hypothesis.
- **Forward test (pre-registered 2026-10-21, do not change the rule):** Kalshi in-game orders ≥$25k at ≤90¢,
  `first_ts ≥ 2026-10-22`, NBA+NFL, one vote per game (mean over that game's qualifying orders of
  won − price). Evaluate after ≥300 games; the edge is confirmed only if the mean is > 0 with a 95% CI
  excluding 0. Until then, no "smart money" claims in product copy.

Large taker orders that sweep several price levels show up as **multiple fills** — the alert logic
should cluster same-market, same-side fills within a short window into one "whale order".

---

## Infrastructure

| Piece | Where | Status |
|---|---|---|
| Neon DB | Project `whale-tracker` = `delicate-truth-19936801` (org "Vercel: SG Enterprises", us-east-1, PG 18). Vercel-managed: create projects from **Vercel → Storage**, not neon.tech | Schema applied, backfill running |
| Website | Vercel project `whale-tracker` (`prj_UtDvrKKNpdITXMP8MLcNEjSPMKym`) on SG Enterprises, root `apps/web` | Preview deploys from branch; Vercel-login protected |
| Collector | EC2 `i-0835de91f980bce2a` "whale-tracker" (t4g.small arm64, Ubuntu 24.04, us-east-1). Separate from ArbScout's DELTIX — never touch DELTIX from this project | Running |
| Payments | Stripe (already installed as a Vercel integration on the SG Enterprises team) | Not wired |

### EC2 collector box
- Access: **SSM only** (security group `sg-0fcfb29512bd3bc92` has no inbound rules; no SSH key).
  Role/instance profile `WHALE-TRACKER-EC2`: SSM core + read `s3://whale-tracker-deploy-597341304953/releases/*`
  + read SSM params `/whale-tracker/*`.
- Secrets live in **SSM Parameter Store** `/whale-tracker/*` (SecureString): `WHALE_DATABASE_URL`,
  `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY` (PEM with literal `\n`), `POLYMARKET_KEY_ID`,
  `POLYMARKET_SECRET_KEY`, `TELEGRAM_BOT_TOKEN` (@splashspybot, "$PLASHSPY"), `TELEGRAM_CHAT_ID`
  (owner's private chat). `bootstrap.sh` renders them into root-only `/etc/whale-tracker.env`.
- Deploy: `git archive --format=tar.gz HEAD` → presigned PUT to `releases/whale-tracker.tgz` →
  SSM RunShellScript: download, untar into `/opt/whale-tracker`, `bash infra/ec2/bootstrap.sh`.
- systemd units (`infra/ec2/`): `whale-live` (always on), `whale-backfill` (full history, resumable,
  exits when done), `whale-backfill-daily.timer` (10:00 UTC: `sync-games.ts`, then `--recent-days 3`).
- Logs: `/var/log/whale-tracker/{live,backfill,backfill-daily}.log`; bootstrap: `/var/log/whale-bootstrap.log`.
- **Rotating a secret** (e.g. Neon password reset): update the SSM parameter, then via SSM run
  `bash /opt/whale-tracker/infra/ec2/render-env.sh && systemctl restart whale-live whale-backfill`.
  - SSM `AWS-RunShellScript` runs **sh/dash**, not bash: always call scripts with `bash …`. dash's `echo`
    expands `\n` in the Kalshi PEM and breaks the env file (happened 2026-10-21).
  - **Never print `/etc/whale-tracker.env`** or any slice of it (`cut`, `head`, `cat`) — it holds private
    keys. List variable names only: `cut -d= -f1`. `render-env.sh` already validates line format.
- A Neon password reset immediately breaks new DB connections on the box; the live collector requeues
  unsaved trades/whale orders/stats in memory (cap 200k trades) until the DB is reachable again.

**Vercel Hobby is non-commercial** — keep everything on the SG Enterprises team.

### Database connection — read this
- **Website (Vercel)** reads via `WHALE_DATABASE_URL` = read-only role `whale_reader` (SQL-created; SELECT only,
  `default_transaction_read_only=on`) on the **main** branch, set for preview + production. Don't use the
  integration's `DATABASE_URL` there: the Neon↔Vercel integration makes a per-git-branch DB copy
  (`preview/<branch>`) for previews, frozen at branch creation (it lacked `whale_orders` → build failure).
- Website roles (all SQL-created, main branch): `whale_reader` (SELECT feed tables; public feed),
  `whale_app` (SELECT feed tables + SELECT/INSERT/UPDATE `user_alert_prefs` + INSERT `telegram_link_tokens`; account page, Vercel env
  `WHALE_APP_DATABASE_URL`). Vercel also has `WHALE_NEON_AUTH_URL` (main-branch auth, so previews share real
  users) and `NEON_AUTH_COOKIE_SECRET`.
- Roles created via the Neon API/console join `neon_superuser` and can't be revoked by `neondb_owner` —
  create restricted roles with SQL instead.
- Code reads **`WHALE_DATABASE_URL`**, never `DATABASE_URL`. The shared cloud environment sets
  `DATABASE_URL` to the **ArbScout** DB (`neon-violet-yacht`), and `tsx --env-file` does not override
  variables that are already set — using `DATABASE_URL` would silently write into ArbScout.
- Claude Code cloud sessions block outbound TCP 5432. Set `WHALE_DB_DRIVER=neon-ws` there (Neon
  serverless driver over WebSockets on 443). EC2 uses the default `pg` driver.
- The Neon MCP connector can query this project directly (`project_id: delicate-truth-19936801`).

User is in Minnesota: launch scripts with `TZ=America/Chicago`; keep all date math in UTC.

---

## Commands

```bash
npm install
cp .env.example .env            # fill WHALE_DATABASE_URL (+ WHALE_DB_DRIVER=neon-ws in cloud sessions)
npm run db:migrate
npm run backfill:kalshi -- --leagues NFL --max-events 2 --dry-run   # no DB, prints stats
TZ=America/Chicago npm run backfill:kalshi -- --leagues NFL,NBA,MLB # full, resumable
npm run typecheck
```

---

## Roadmap

1. ✅ Repo scaffold, schema, Kalshi backfill (dry-run verified live)
2. ⏳ Full Kalshi backfill into Neon — NFL complete; running on EC2 (resumable) + daily catch-up timer
3. ✅ Live collector on EC2 (Kalshi + PM.US → trades, stats, whale_orders) + Telegram alerts
   (`apps/collector/src/telegram.ts`): fan-out to every `user_alert_prefs` row with `telegram_chat_id`, filtered
   by that user's leagues / per-league `min_usd` / platforms / `max_price` / `live_only`. Owner's
   `TELEGRAM_CHAT_ID` gets env defaults (NFL $50k, NBA $25k, ≤90¢; `TELEGRAM_MIN_USD_<LEAGUE>` overrides)
   unless that chat is linked to an account. Paced ≤1 msg/s per chat, ≤25/s overall; 403 → auto-unlink.
   **Linking:** `/account` → "Connect Telegram" inserts a 15-min code into `telegram_link_tokens` →
   `t.me/splashspybot?start=<code>`; the collector long-polls `getUpdates` (it must be the only consumer —
   never set a webhook or run a second collector) and handles `/start <code>` and `/stop`.
4. Size report → default thresholds per league and tier boundaries
5. ✅ `apps/web` on Vercel: whale feed, Neon Auth sign-up/sign-in, `/account` alert settings + Telegram linking.
   Production = `main` → https://whale-tracker-ashen.vercel.app (Git-connected; still behind Vercel login
   until a custom domain or protection change). Other branches → preview deployments.
6. ⏸ Stripe (waiting on the new company's own Stripe account): products/prices per tier, Checkout,
   Customer Portal, webhooks → `user_alert_prefs.tier`
7. Channels: Discord, email, web push, SMS

Tier sketch (finalize from data): **Free** — delayed/digest, 1 league, email, fixed high threshold ·
**Pro ~$19/mo** — real-time, all leagues, custom thresholds, Telegram/Discord/email/push ·
**Whale ~$49/mo** — + SMS, per-team/market filters, flow summaries, full history/export, API.
