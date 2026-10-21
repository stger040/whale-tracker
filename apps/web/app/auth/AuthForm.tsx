'use client';

import Link from 'next/link';
import { useActionState } from 'react';

type Action = (prev: { error: string } | null, form: FormData) => Promise<{ error: string } | null>;

const input =
  'block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none';

export function AuthForm({ mode, action }: { mode: 'sign-in' | 'sign-up'; action: Action }) {
  const [state, formAction, pending] = useActionState(action, null);
  const signUp = mode === 'sign-up';
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <Link href="/" className="mb-6 text-sm uppercase tracking-widest text-[var(--accent)]">$PLASHSPY</Link>
      <h1 className="mb-6 text-2xl font-bold">{signUp ? 'Create your account' : 'Sign in'}</h1>
      <form action={formAction} className="flex flex-col gap-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5">
        {signUp && (
          <label className="flex flex-col gap-1.5 text-sm">
            Name
            <input name="name" type="text" required autoComplete="name" className={input} />
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-sm">
          Email
          <input name="email" type="email" required autoComplete="email" className={input} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          Password
          <input name="password" type="password" required minLength={8}
            autoComplete={signUp ? 'new-password' : 'current-password'} className={input} />
        </label>
        {state?.error && <p className="text-sm text-[var(--no)]">{state.error}</p>}
        <button type="submit" disabled={pending}
          className="rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-[#0b1220] hover:opacity-90 disabled:opacity-60">
          {pending ? 'One moment…' : signUp ? 'Create account' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-sm text-[var(--muted)]">
        {signUp ? 'Already have an account? ' : 'New here? '}
        <Link href={signUp ? '/auth/sign-in' : '/auth/sign-up'} className="text-[var(--accent)] hover:underline">
          {signUp ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </main>
  );
}
