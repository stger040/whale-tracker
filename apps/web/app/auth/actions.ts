'use server';

import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth/server';

export async function signInWithEmail(_prev: { error: string } | null, form: FormData) {
  const { error } = await auth.signIn.email({
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  });
  if (error) {
    console.error('[auth] sign-in failed:', error.status, error.message);
    return { error: error.message || 'Could not sign in. Check your email and password.' };
  }
  redirect('/account');
}

export async function signUpWithEmail(_prev: { error: string } | null, form: FormData) {
  const password = String(form.get('password') ?? '');
  if (password !== String(form.get('confirm') ?? '')) return { error: 'Passwords don’t match.' };
  const { error } = await auth.signUp.email({
    name: String(form.get('name') ?? ''),
    email: String(form.get('email') ?? ''),
    password,
  });
  if (error) {
    console.error('[auth] sign-up failed:', error.status, error.message);
    return { error: error.message || 'Could not create your account.' };
  }
  redirect('/account');
}

export async function signOut() {
  await auth.signOut();
  redirect('/');
}
