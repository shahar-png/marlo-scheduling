// The **Edge-safe** half of the Auth.js configuration.
//
// `middleware.ts` runs in the Edge runtime, where `node:crypto` does not exist.
// Everything middleware needs is here — the provider, the sign-in page, and the
// `authorized` callback that guards `/host` — and nothing here reaches the
// booking runtime, whose Google adapters encrypt refresh tokens with
// `node:crypto` (AC-14).
//
// `lib/auth/config.ts` spreads this and adds the Node-only `signIn` callback
// that materializes the owner (C1). Keeping the two apart is what stops the
// whole durable stack from being pulled into the Edge bundle.

import Google from 'next-auth/providers/google';
import type { NextAuthConfig } from 'next-auth';
import { ALLOWED_GOOGLE_HOSTED_DOMAIN } from './workspace';
import { isAuthorizedForPath } from './host-guard';

// C7 / AC-14 — the consent scope set is **exactly** this, in one consent:
// `calendar.freebusy` is what the retained multi-host read needs,
// `calendar.events` is what `events.list` / `insert` / `patch` / `delete` need,
// and `gmail.send` is what P3's real emails need. `access_type=offline` +
// `prompt=consent` are what produce the refresh token stored (encrypted) in
// `host_tokens`.
export const GOOGLE_CONSENT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar.freebusy',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/gmail.send',
] as const;

export const googleProvider = Google({
  clientId: process.env.AUTH_GOOGLE_ID,
  clientSecret: process.env.AUTH_GOOGLE_SECRET,
  authorization: {
    params: {
      hd: ALLOWED_GOOGLE_HOSTED_DOMAIN,
      access_type: 'offline',
      prompt: 'consent',
      scope: GOOGLE_CONSENT_SCOPES.join(' '),
    },
  },
});

export const edgeAuthConfig = {
  providers: [googleProvider],
  pages: {
    signIn: '/signin',
  },
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      return isAuthorizedForPath(auth, request.nextUrl.pathname);
    },
  },
} satisfies NextAuthConfig;
