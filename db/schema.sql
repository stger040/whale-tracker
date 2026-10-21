-- whale-tracker schema. Idempotent: safe to run on every deploy (npm run db:migrate).
-- Always apply via the pg Pool, never the neon() HTTP client — DDL through the
-- pooler can silently fail to commit (learned on ArbScout).

CREATE TABLE IF NOT EXISTS markets (
  platform        TEXT        NOT NULL,             -- 'kalshi' | 'pmus'
  market_ticker   TEXT        NOT NULL,             -- Kalshi ticker / PM.US slug
  event_ticker    TEXT        NOT NULL,
  series_ticker   TEXT        NOT NULL,
  league          TEXT        NOT NULL,
  title           TEXT,
  yes_sub_title   TEXT,
  open_time       TIMESTAMPTZ,
  close_time      TIMESTAMPTZ,
  result          TEXT,
  -- Backfill bookkeeping: set once every trade for the market has been processed.
  backfilled_at   TIMESTAMPTZ,
  PRIMARY KEY (platform, market_ticker)
);
CREATE INDEX IF NOT EXISTS markets_league_close_idx ON markets (league, close_time);

-- Individual trades at or above MIN_STORE_USD notional. Smaller trades are only
-- counted in market_trade_stats so distributions stay exact without storing every $5 fill.
CREATE TABLE IF NOT EXISTS trades (
  platform        TEXT        NOT NULL,
  trade_id        TEXT        NOT NULL,
  market_ticker   TEXT        NOT NULL,
  event_ticker    TEXT        NOT NULL,
  league          TEXT        NOT NULL,
  ts              TIMESTAMPTZ NOT NULL,             -- exchange trade time (UTC)
  taker_side      TEXT        NOT NULL,             -- outcome the taker bought: 'yes' | 'no'
  taker_price     NUMERIC     NOT NULL,             -- $ per contract the taker paid (0–1)
  yes_price       NUMERIC     NOT NULL,
  contracts       NUMERIC     NOT NULL,             -- NUMERIC, not SMALLINT: sizes run to 6+ digits
  notional_usd    NUMERIC     NOT NULL,             -- contracts × taker_price
  is_block_trade  BOOLEAN     NOT NULL DEFAULT FALSE,
  PRIMARY KEY (platform, trade_id)
);
CREATE INDEX IF NOT EXISTS trades_league_ts_idx       ON trades (league, ts DESC);
CREATE INDEX IF NOT EXISTS trades_market_ts_idx       ON trades (platform, market_ticker, ts);
CREATE INDEX IF NOT EXISTS trades_league_notional_idx ON trades (league, notional_usd DESC);

-- Per-market trade-size summary over ALL trades (no floor). bucket_counts/bucket_sums
-- align with bucket_edges_usd; sum them across markets for league-wide distributions.
CREATE TABLE IF NOT EXISTS market_trade_stats (
  platform          TEXT        NOT NULL,
  market_ticker     TEXT        NOT NULL,
  league            TEXT        NOT NULL,
  trade_count       INTEGER     NOT NULL,
  total_notional    NUMERIC     NOT NULL,
  p50_usd           NUMERIC,
  p90_usd           NUMERIC,
  p99_usd           NUMERIC,
  p999_usd          NUMERIC,
  max_usd           NUMERIC,
  bucket_edges_usd  NUMERIC[]   NOT NULL,
  bucket_counts     INTEGER[]   NOT NULL,
  bucket_sums       NUMERIC[]   NOT NULL,
  first_trade_ts    TIMESTAMPTZ,
  last_trade_ts     TIMESTAMPTZ,
  computed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (platform, market_ticker)
);
CREATE INDEX IF NOT EXISTS market_trade_stats_league_idx ON market_trade_stats (league);

-- PM.US taker intent (opening vs closing a position). NULL for Kalshi.
ALTER TABLE trades ADD COLUMN IF NOT EXISTS taker_intent TEXT;

-- Whale orders: same-market, same-taker-direction fills clustered within a short window
-- (a large taker order sweeping several price levels arrives as many fills). Written by the
-- live collector for every cluster ≥ WHALE_LOG_MIN_USD; per-user alert thresholds are
-- applied on top of this table. This is the feed the website and alerts read.
CREATE TABLE IF NOT EXISTS whale_orders (
  id              BIGSERIAL   PRIMARY KEY,
  platform        TEXT        NOT NULL,
  market_ticker   TEXT        NOT NULL,
  event_ticker    TEXT        NOT NULL,
  league          TEXT        NOT NULL,
  taker_side      TEXT        NOT NULL,             -- 'yes' | 'no'
  taker_intent    TEXT,                             -- PM.US only, from the first fill
  first_ts        TIMESTAMPTZ NOT NULL,
  last_ts         TIMESTAMPTZ NOT NULL,
  fills           INTEGER     NOT NULL,
  contracts       NUMERIC     NOT NULL,
  notional_usd    NUMERIC     NOT NULL,
  vwap_price      NUMERIC     NOT NULL,             -- taker-side volume-weighted price
  min_price       NUMERIC     NOT NULL,
  max_price       NUMERIC     NOT NULL,
  -- Payout if the taker's side wins: contracts × $1. Bets at 95¢ have tiny upside vs. stake.
  potential_payout_usd NUMERIC NOT NULL,
  trade_ids       TEXT[]      NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (platform, market_ticker, first_ts, taker_side)
);
CREATE INDEX IF NOT EXISTS whale_orders_ts_idx     ON whale_orders (first_ts DESC);
CREATE INDEX IF NOT EXISTS whale_orders_league_idx ON whale_orders (league, first_ts DESC);

-- Games from ESPN's scoreboard (authoritative start time + final score). Kalshi/PM.US markets link
-- here via markets.game_id so trades can be labelled pre-game vs in-game.
CREATE TABLE IF NOT EXISTS games (
  game_id      TEXT        PRIMARY KEY,               -- 'espn:<id>'
  league       TEXT        NOT NULL,
  start_time   TIMESTAMPTZ NOT NULL,
  away_abbr    TEXT        NOT NULL,                  -- ESPN abbreviations
  home_abbr    TEXT        NOT NULL,
  away_name    TEXT        NOT NULL,
  home_name    TEXT        NOT NULL,
  status       TEXT        NOT NULL,
  away_score   INTEGER,
  home_score   INTEGER,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_league_start_idx ON games (league, start_time);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS game_id TEXT;
CREATE INDEX IF NOT EXISTS markets_game_idx ON markets (game_id);
