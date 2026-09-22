import Google from 'next-auth/providers/google';
import type { NextAuthConfig } from 'next-auth';
import {
  ALLOWED_GOOGLE_HOSTED_DOMAIN,
  isAllowedGoogleWorkspaceIdentity,
} from './workspace';
import { isAuthorizedForPath } from './host-guard';
import { resolveSignIn } from './sign-in';
import { getRuntime } from '../booking/runtime';

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

function hostedDomainFromProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  const hd = (profile as { hd?: unknown }).hd;
  return typeof hd === 'string' ? hd : null;
}

function givenNameFromProfile(profile: unknown): string | null {
  if (!profile || typeof profile !== 'object') {
    return null;
  }
  const given = (profile as { given_name?: unknown }).given_name;
  return typeof given === 'string' ? given : null;
}

export const authConfig = {
  providers: [googleProvider],
  pages: {
    signIn: '/signin',
  },
  trustHost: true,
  callbacks: {
    authorized({ auth, request }) {
      return isAuthorizedForPath(auth, request.nextUrl.pathname);
    },
    async signIn({ profile }) {
      if (
        !isAllowedGoogleWorkspaceIdentity({
          email: profile?.email,
          hd: hostedDomainFromProfile(profile),
        })
      ) {
        return false;
      }
      // C1: the callback upserts `owners` and materializes that owner's
      // fixture-defined event types and schedule under the stable ids. A
      // reserved local-part fails here with `owner_slug_reserved` before any
      // write (REV5-06).
      const decision = await resolveSignIn({
        owners: getRuntime().owners,
        email: profile?.email ?? null,
        givenName: givenNameFromProfile(profile),
      });
      return decision.ok ? true : decision.redirect;
    },
  },
} satisfies NextAuthConfig;
