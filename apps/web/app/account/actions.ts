'use server';

import { revalidatePath } from 'next/cache';
import { auth } from '@/lib/auth/server';
import { LEAGUES, savePrefs, type League } from '@/lib/prefs';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export async function saveAlertPrefs(_prev: { ok?: boolean; error?: string } | null, form: FormData) {
  const { data: session } = await auth.getSession();
  if (!session?.user) return { error: 'Please sign in again.' };

  const leagues = LEAGUES.filter(l => form.get(`league_${l}`) === 'on');
  const minUsd = Object.fromEntries(
    LEAGUES.map(l => [l, clamp(Number(form.get(`min_${l}`)) || 25_000, 5_000, 1_000_000)]),
  ) as Record<League, number>;
  const platforms = (['kalshi', 'pmus'] as const).filter(p => form.get(`platform_${p}`) === 'on');
  if (!leagues.length) return { error: 'Pick at least one league.' };
  if (!platforms.length) return { error: 'Pick at least one platform.' };

  await savePrefs(session.user.id, session.user.email, {
    leagues,
    minUsd,
    maxPrice: form.get('skip_locks') === 'on' ? 0.9 : 0.99,
    platforms,
    liveOnly: form.get('live_only') === 'on',
  });
  revalidatePath('/account');
  return { ok: true };
}
