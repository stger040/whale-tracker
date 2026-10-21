# Whale Tracker

Real-time alerts for large trades on Kalshi and Polymarket US sports markets (NFL, NBA, MLB, tennis, golf).

## Quick start

```bash
npm install
cp .env.example .env        # set WHALE_DATABASE_URL
npm run db:migrate
npm run backfill:kalshi -- --leagues NFL --max-events 2 --dry-run
```

See [CLAUDE.md](CLAUDE.md) for architecture, confirmed API facts, and the roadmap.
