'use client';

import { createAuthClient } from '@neondatabase/auth/next';

// Browser-side Neon Auth client; talks to our own /api/auth/* proxy route.
export const authClient = createAuthClient();
