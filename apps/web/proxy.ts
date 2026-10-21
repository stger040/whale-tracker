import { auth } from '@/lib/auth/server';

// Next 16: proxy.ts replaces middleware.ts. Redirects signed-out visitors to sign-in.
export default auth.middleware({ loginUrl: '/auth/sign-in' });

export const config = { matcher: ['/account/:path*'] };
