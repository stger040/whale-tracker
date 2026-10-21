import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/server';
import { getPrefs } from '@/lib/prefs';
import { signOut } from '../auth/actions';
import { PrefsForm } from './PrefsForm';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Account — $PLASHSPY' };

export default async function AccountPage() {
  const { data: session } = await auth.getSession();
  if (!session?.user) redirect('/auth/sign-in');
  const prefs = await getPrefs(session.user.id);

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <header className="mb-8 flex items-center justify-between">
        <Link href="/" className="text-sm uppercase tracking-widest text-[var(--accent)]">$PLASHSPY</Link>
        <form action={signOut}>
          <button className="text-sm text-[var(--muted)] hover:text-[var(--ink)]">Sign out</button>
        </form>
      </header>
      <h1 className="text-2xl font-bold">Your alerts</h1>
      <p className="mt-1 mb-6 text-[var(--muted)]">
        Signed in as {session.user.email} · plan: <span className="capitalize">{prefs.tier}</span>
      </p>
      <PrefsForm prefs={prefs} />
      <section className="mt-8 rounded-xl border border-dashed border-[var(--line)] p-4 text-sm text-[var(--muted)]">
        Telegram delivery: {prefs.telegramLinked ? 'connected ✓' : 'coming next — you’ll link @splashspybot from here.'}
      </section>
    </main>
  );
}
