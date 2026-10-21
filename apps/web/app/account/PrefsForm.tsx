'use client';

import { useActionState } from 'react';
import type { AlertPrefs } from '@/lib/prefs';
import { saveAlertPrefs } from './actions';

const box = 'h-4 w-4 accent-[var(--accent)]';
const num = 'w-32 rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-1.5 text-right';

export function PrefsForm({ prefs }: { prefs: AlertPrefs }) {
  const [state, action, pending] = useActionState(saveAlertPrefs, null);
  return (
    <form action={action} className="flex flex-col gap-6">
      <fieldset className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <legend className="px-1 text-sm text-[var(--muted)]">Leagues & minimum order size</legend>
        {(['NBA', 'NFL'] as const).map(l => (
          <div key={l} className="flex items-center justify-between gap-4 py-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" name={`league_${l}`} defaultChecked={prefs.leagues.includes(l)} className={box} />
              {l}
            </label>
            <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
              alert at $
              <input type="number" name={`min_${l}`} min={5000} step={1000} defaultValue={prefs.minUsd[l]} className={num} />
            </label>
          </div>
        ))}
        <p className="mt-2 text-xs text-[var(--muted)]">
          Typical night: NBA $25k ≈ 2–3 alerts per game · NFL $50k ≈ 1–2 per game.
        </p>
      </fieldset>

      <fieldset className="rounded-xl border border-[var(--line)] bg-[var(--panel)] p-4">
        <legend className="px-1 text-sm text-[var(--muted)]">Filters</legend>
        <label className="flex items-center gap-2 py-1">
          <input type="checkbox" name="platform_kalshi" defaultChecked={prefs.platforms.includes('kalshi')} className={box} /> Kalshi
        </label>
        <label className="flex items-center gap-2 py-1">
          <input type="checkbox" name="platform_pmus" defaultChecked={prefs.platforms.includes('pmus')} className={box} /> Polymarket US
        </label>
        <label className="flex items-center gap-2 py-1">
          <input type="checkbox" name="skip_locks" defaultChecked={prefs.maxPrice <= 0.9} className={box} />
          Skip near-certain bets (priced above 90¢)
        </label>
        <label className="flex items-center gap-2 py-1">
          <input type="checkbox" name="live_only" defaultChecked={prefs.liveOnly} className={box} />
          Only in-game orders
        </label>
      </fieldset>

      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending}
          className="rounded-lg bg-[var(--accent)] px-4 py-2 font-semibold text-[#0b1220] hover:opacity-90 disabled:opacity-60">
          {pending ? 'Saving…' : 'Save alert settings'}
        </button>
        {state?.ok && <span className="text-sm text-[var(--yes)]">Saved.</span>}
        {state?.error && <span className="text-sm text-[var(--no)]">{state.error}</span>}
      </div>
    </form>
  );
}
