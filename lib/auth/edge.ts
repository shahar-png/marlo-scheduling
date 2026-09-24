// The Auth.js instance `middleware.ts` re-exports. It is built from the
// Edge-safe config alone, so nothing here can pull `node:crypto` — or the
// durable booking runtime behind it — into the Edge bundle.

import NextAuth from 'next-auth';
import { edgeAuthConfig } from './edge-config';

export const { auth } = NextAuth(edgeAuthConfig);
