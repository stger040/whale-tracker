-- Do large bets win more often than their price implies?  (Kalshi, settled game markets)
-- Run via the Neon MCP connector (project delicate-truth-19936801) or psql.
--
-- Method notes (learned the hard way, 2026-10-21):
--  * Unit of analysis = an ORDER: same market + side, fills ≤ 2s apart (matches the live clusterer).
--  * Price each order at the time it was placed. Do NOT average price across a whole game per side:
--    the eventual winner is bought heavily late at high prices, so game-wide VWAP leaks the outcome.
--  * Orders inside one game are correlated. Judge significance with one vote per GAME, not per order.
--  * Edge = win rate − average price paid (percentage points). ROI is dollar-weighted and dominated by
--    a few large longshot payouts — don't read it as an edge on its own.

WITH f AS (
  SELECT t.league, t.market_ticker, m.event_ticker, t.taker_side, t.ts, t.notional_usd, t.contracts,
         (t.taker_side = m.result)::int AS won,
         CASE WHEN lag(t.ts) OVER w IS NULL OR t.ts - lag(t.ts) OVER w > interval '2 seconds' THEN 1 ELSE 0 END AS new_order
  FROM trades t JOIN markets m ON m.platform = t.platform AND m.market_ticker = t.market_ticker
  WHERE t.platform = 'kalshi' AND m.result IN ('yes','no') AND t.notional_usd >= 1000
  WINDOW w AS (PARTITION BY t.market_ticker, t.taker_side ORDER BY t.ts)
), g AS (
  SELECT *, sum(new_order) OVER (PARTITION BY market_ticker, taker_side ORDER BY ts) AS oid FROM f
), orders AS (
  SELECT league, event_ticker, min(ts) AS ts, sum(notional_usd) AS usd, sum(contracts) AS contracts,
         sum(notional_usd) / sum(contracts) AS price, max(won) AS won
  FROM g GROUP BY league, market_ticker, event_ticker, taker_side, oid
), per_game AS (                       -- one vote per game: average the big orders within each game
  SELECT league, event_ticker, avg(price) AS price, avg(won) AS won
  FROM orders WHERE usd >= 25000 GROUP BY 1, 2
)
SELECT league, count(*) AS games,
       round(avg(price) * 100, 1)                                  AS implied_pct,
       round(avg(won) * 100, 1)                                    AS won_pct,
       round((avg(won) - avg(price)) * 100, 1)                     AS edge_pp,
       round(1.96 * sqrt(avg(price) * (1 - avg(price)) / count(*)) * 100, 1) AS ci95_pp
FROM per_game GROUP BY ROLLUP (league) ORDER BY league;
