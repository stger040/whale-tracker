-- Post-trade price impact of large orders (informed-flow test). Kalshi NBA + NFL.
-- Builds analysis.order_impact, then summarises. Run: npm run sql -- analysis/price-impact.sql
--
-- For each order (fills clustered ≤2s, same market+side), compare the price of the side it bought
-- just BEFORE the order (last other trade) with the price 1 / 5 / 15 minutes AFTER its last fill.
-- Positive move = price drifted toward the whale's side. Compare big orders with a control group of
-- small orders: informed money shows up as a larger, persistent drift after big orders.
-- Orders priced > 90¢ are excluded (little room to move; mostly end-of-game locks).
-- Caveat: prices are from stored trades (≥ $500), so "price at t" = last such trade at or before t.

CREATE SCHEMA IF NOT EXISTS analysis;
DROP TABLE IF EXISTS analysis.order_impact;

CREATE TABLE analysis.order_impact AS
WITH f AS (
  SELECT t.league, t.market_ticker, t.taker_side, t.ts, t.trade_id, t.notional_usd, t.contracts,
         CASE WHEN lag(t.ts) OVER w IS NULL OR t.ts - lag(t.ts) OVER w > interval '2 seconds' THEN 1 ELSE 0 END AS new_order
  FROM trades t
  WHERE t.platform = 'kalshi' AND t.league IN ('NBA', 'NFL') AND t.notional_usd >= 1000
  WINDOW w AS (PARTITION BY t.market_ticker, t.taker_side ORDER BY t.ts)
), g AS (
  SELECT *, sum(new_order) OVER (PARTITION BY market_ticker, taker_side ORDER BY ts) AS oid FROM f
), o AS (
  SELECT league, market_ticker, taker_side, min(ts) AS first_ts, max(ts) AS last_ts,
         sum(notional_usd) AS usd, sum(notional_usd) / sum(contracts) AS price
  FROM g GROUP BY league, market_ticker, taker_side, oid
), picked AS (
  SELECT *, CASE WHEN usd >= 25000 THEN 'whale_25k+' WHEN usd >= 10000 THEN 'big_10-25k' ELSE 'control_1-5k' END AS grp
  FROM o
  WHERE price <= 0.90
    AND (usd >= 10000 OR (usd < 5000 AND random() < 0.05))   -- 5% sample of small orders as control
)
SELECT p.*, m.event_ticker, m.result, gm.start_time AS game_start,
       CASE WHEN gm.start_time IS NULL THEN 'unknown'
            WHEN p.first_ts < gm.start_time THEN 'pre-game' ELSE 'in-game' END AS phase,
       pre.px  AS px_before,
       a1.px   AS px_1m,
       a5.px   AS px_5m,
       a15.px  AS px_15m
FROM picked p
JOIN markets m ON m.platform = 'kalshi' AND m.market_ticker = p.market_ticker
LEFT JOIN games gm ON gm.game_id = m.game_id
-- price of the whale's side, expressed from that side's point of view
LEFT JOIN LATERAL (
  SELECT CASE WHEN p.taker_side = 'yes' THEN x.yes_price ELSE 1 - x.yes_price END AS px
  FROM trades x WHERE x.platform = 'kalshi' AND x.market_ticker = p.market_ticker AND x.ts < p.first_ts
  ORDER BY x.ts DESC LIMIT 1) pre ON true
LEFT JOIN LATERAL (
  SELECT CASE WHEN p.taker_side = 'yes' THEN x.yes_price ELSE 1 - x.yes_price END AS px
  FROM trades x WHERE x.platform = 'kalshi' AND x.market_ticker = p.market_ticker
    AND x.ts > p.last_ts AND x.ts <= p.last_ts + interval '1 minute'
  ORDER BY x.ts DESC LIMIT 1) a1 ON true
LEFT JOIN LATERAL (
  SELECT CASE WHEN p.taker_side = 'yes' THEN x.yes_price ELSE 1 - x.yes_price END AS px
  FROM trades x WHERE x.platform = 'kalshi' AND x.market_ticker = p.market_ticker
    AND x.ts > p.last_ts AND x.ts <= p.last_ts + interval '5 minutes'
  ORDER BY x.ts DESC LIMIT 1) a5 ON true
LEFT JOIN LATERAL (
  SELECT CASE WHEN p.taker_side = 'yes' THEN x.yes_price ELSE 1 - x.yes_price END AS px
  FROM trades x WHERE x.platform = 'kalshi' AND x.market_ticker = p.market_ticker
    AND x.ts > p.last_ts AND x.ts <= p.last_ts + interval '15 minutes'
  ORDER BY x.ts DESC LIMIT 1) a15 ON true;

-- Summary: average move (cents) toward the whale's side, by group / league / phase.
SELECT grp, league, phase, count(*) AS orders, count(DISTINCT event_ticker) AS games,
       round(avg(px_1m  - px_before) * 100, 2) AS move_1m_c,
       round(avg(px_5m  - px_before) * 100, 2) AS move_5m_c,
       round(avg(px_15m - px_before) * 100, 2) AS move_15m_c,
       round((stddev(px_15m - px_before) / sqrt(count(DISTINCT event_ticker)) * 196)::numeric, 2) AS ci95_15m_c
FROM analysis.order_impact
WHERE px_before IS NOT NULL AND px_15m IS NOT NULL
GROUP BY ROLLUP (grp, league, phase)
HAVING grp IS NOT NULL
ORDER BY grp, league NULLS FIRST, phase NULLS FIRST;
