import { recentWhales, summary, type WhaleRow } from '@/lib/db';

// Re-render at most every 30s; the collector writes whale_orders continuously.
export const revalidate = 30;

const usd = (n: number) =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `$${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `$${Math.round(n)}`;
const cents = (p: number) => `${Math.round(p * 100)}¢`;
const timeCT = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function pick(w: WhaleRow): string {
  const team = w.team ?? 'YES';
  return w.taker_side === 'yes' ? `${team} to win` : `Against ${team}`;
}

function phase(w: WhaleRow): { label: string; cls: string } {
  if (!w.game_start) return { label: '—', cls: 'text-[var(--muted)]' };
  return new Date(w.first_ts) < new Date(w.game_start)
    ? { label: 'Pre-game', cls: 'text-sky-300' }
    : { label: 'Live', cls: 'text-amber-300' };
}

export default async function Home() {
  const [whales, stats] = await Promise.all([recentWhales(10_000, 48), summary(24)]);

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-8">
        <p className="text-sm uppercase tracking-widest text-[var(--accent)]">$PLASHSPY</p>
        <h1 className="mt-1 text-3xl font-bold">Where the big money is moving</h1>
        <p className="mt-2 max-w-2xl text-[var(--muted)]">
          Large orders on NBA and NFL game markets across Kalshi and Polymarket US, grouped into whole orders and
          flagged the moment they hit. Size and flow — not picks: big bettors aren&apos;t reliably right.
        </p>
      </header>

      <section className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {['NBA', 'NFL'].map(league => {
          const s = stats.find(x => x.league === league);
          return (
            <div key={league} className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
              <div className="text-sm text-[var(--muted)]">{league} · last 24h · orders ≥ $25k</div>
              <div className="mt-1 flex items-baseline gap-4">
                <span className="text-2xl font-semibold">{s?.orders ?? 0}</span>
                <span className="text-[var(--muted)]">{usd(Number(s?.volume_usd ?? 0))} total</span>
                <span className="text-[var(--muted)]">biggest {usd(Number(s?.biggest_usd ?? 0))}</span>
              </div>
            </div>
          );
        })}
      </section>

      <section>
        <h2 className="mb-3 text-lg font-semibold">Latest whale orders <span className="text-sm font-normal text-[var(--muted)]">≥ $10k · last 48h</span></h2>
        {whales.length === 0 ? (
          <p className="text-[var(--muted)]">No whale orders yet in this window.</p>
        ) : (
          <ul className="divide-y divide-[var(--line)] overflow-hidden rounded-xl border border-[var(--line)] bg-[var(--panel)]">
            {whales.map(w => {
              const notional = Number(w.notional_usd);
              const payout = Number(w.potential_payout_usd);
              const ph = phase(w);
              return (
                <li key={w.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <div className="w-28 shrink-0 text-xs text-[var(--muted)]">
                    {timeCT(w.first_ts)}
                    <div className={ph.cls}>{ph.label}</div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">
                      <span className={w.taker_side === 'yes' ? 'text-[var(--yes)]' : 'text-[var(--no)]'}>{pick(w)}</span>
                      <span className="ml-2 text-xs text-[var(--muted)]">
                        {w.league} · {w.platform === 'kalshi' ? 'Kalshi' : 'Polymarket US'}
                        {w.taker_intent?.includes('SELL_') ? ' · closing' : ''}
                      </span>
                    </div>
                    <div className="truncate text-xs text-[var(--muted)]">
                      {w.away_name && w.home_name ? `${w.away_name} @ ${w.home_name}` : w.title}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-lg font-semibold">{usd(notional)}</div>
                    <div className="text-xs text-[var(--muted)]">
                      @ {cents(Number(w.vwap_price))} · pays {usd(payout)} ({(payout / notional).toFixed(2)}x)
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="mt-10 text-xs text-[var(--muted)]">
        Data from public Kalshi and Polymarket US trade feeds. Traders are anonymous. Not financial advice.
      </footer>
    </main>
  );
}
