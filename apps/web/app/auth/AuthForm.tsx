'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { authClient } from '@/lib/auth/client';

type Action = (prev: { error: string } | null, form: FormData) => Promise<{ error: string } | null>;

const input =
  'block w-full rounded-lg border border-[var(--line)] bg-[var(--bg)] px-3 py-2 text-[var(--ink)] placeholder:text-[var(--muted)] focus:border-[var(--accent)] focus:outline-none';

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
      {!open && <path d="M3 3l18 18" />}
    </svg>
  );
}

function PasswordInput(props: {
  name: string; autoComplete: string; value: string; onChange: (v: string) => void; invalid?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input name={props.name} type={show ? 'text' : 'password'} required minLength={8}
        autoComplete={props.autoComplete} value={props.value} onChange={e => props.onChange(e.target.value)}
        aria-invalid={props.invalid || undefined}
        className={`${input} pr-10 ${props.invalid ? 'border-[var(--no)]' : ''}`} />
      <button type="button" onClick={() => setShow(s => !s)}
        aria-label={show ? 'Hide password' : 'Show password'} aria-pressed={show}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-[var(--muted)] hover:text-[var(--ink)]">
        <EyeIcon open={show} />
      </button>
    </div>
  );
}

export function AuthForm({ mode, action }: { mode: 'sign-in' | 'sign-up'; action: Action }) {
  const [state, formAction, pending] = useActionState(action, null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState('');
  const signUp = mode === 'sign-up';
  const mismatch = signUp && confirm.length > 0 && confirm !== password;

  async function continueWithGoogle() {
    setGoogleBusy(true);
    setGoogleError('');
    const { error } = await authClient.signIn.social({ provider: 'google', callbackURL: '/account' });
    // On success the browser is already navigating to Google.
    if (error) {
      setGoogleError(error.message || 'Google sign-in failed. Try again.');
      setGoogleBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <Link href="/" className="mb-6 text-sm uppercase tracking-widest text-[var(--accent)]">$PLASHSPY</Link>
      <h1 className="mb-1 text-2xl font-bold">{signUp ? 'Create your account' : 'Welcome back'}</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        {signUp ? 'Get alerts when big money hits NBA and NFL markets.' : 'Sign in to manage your whale alerts.'}
      </p>
      <div className="flex flex-col gap-4 rounded-xl border border-[var(--line)] bg-[var(--panel)] p-5">
        <button type="button" onClick={continueWithGoogle} disabled={googleBusy}
          className="flex items-center justify-center gap-2 rounded-lg border border-[var(--line)] bg-white px-3 py-2 font-semibold text-[#1f2937] hover:bg-gray-100 disabled:opacity-60">
          <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
            <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
            <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
            <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
            <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
          </svg>
          {googleBusy ? 'Redirecting…' : 'Continue with Google'}
        </button>
        {googleError && <p className="text-sm text-[var(--no)]">{googleError}</p>}

        <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-[var(--muted)]">
          <span className="h-px flex-1 bg-[var(--line)]" />or<span className="h-px flex-1 bg-[var(--line)]" />
        </div>

        <form action={formAction} className="flex flex-col gap-4">
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
            <PasswordInput name="password" autoComplete={signUp ? 'new-password' : 'current-password'}
              value={password} onChange={setPassword} />
            {signUp && <span className="text-xs text-[var(--muted)]">At least 8 characters.</span>}
          </label>
          {signUp && (
            <label className="flex flex-col gap-1.5 text-sm">
              Confirm password
              <PasswordInput name="confirm" autoComplete="new-password" value={confirm} onChange={setConfirm}
                invalid={mismatch} />
              {mismatch && <span className="text-xs text-[var(--no)]">Passwords don’t match.</span>}
              {signUp && confirm.length > 0 && !mismatch && (
                <span className="text-xs text-[var(--yes)]">Passwords match.</span>
              )}
            </label>
          )}
          {state?.error && <p className="text-sm text-[var(--no)]">{state.error}</p>}
          <button type="submit" disabled={pending || mismatch}
            className="rounded-lg bg-[var(--accent)] px-3 py-2 font-semibold text-[#0b1220] hover:opacity-90 disabled:opacity-60">
            {pending ? 'One moment…' : signUp ? 'Create account' : 'Sign in'}
          </button>
        </form>
      </div>
      <p className="mt-4 text-sm text-[var(--muted)]">
        {signUp ? 'Already have an account? ' : 'New here? '}
        <Link href={signUp ? '/auth/sign-in' : '/auth/sign-up'} className="text-[var(--accent)] hover:underline">
          {signUp ? 'Sign in' : 'Create an account'}
        </Link>
      </p>
    </main>
  );
}
