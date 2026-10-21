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
