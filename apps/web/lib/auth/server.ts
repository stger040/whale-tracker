import { createNeonAuth } from '@neondatabase/auth/next/server';

/**
 * Neon Auth (managed Better Auth) on the whale-tracker MAIN branch.
 * WHALE_NEON_AUTH_URL is set explicitly in Vercel: the integration's NEON_AUTH_BASE_URL can point at a
 * per-preview database branch, which would give preview deployments a separate user list.
 */
export const auth = createNeonAuth({
  baseUrl: process.env.WHALE_NEON_AUTH_URL ?? process.env.NEON_AUTH_BASE_URL!,
  cookies: { secret: process.env.NEON_AUTH_COOKIE_SECRET! },
});
