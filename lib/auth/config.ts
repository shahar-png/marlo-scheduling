// The full Auth.js configuration, for the Node runtime only.
//
// It is `edgeAuthConfig` plus the `signIn` callback, which materializes the
// owner (C1) and therefore reaches the booking runtime and `node:crypto`.
// `middleware.ts` must never import this file — see `lib/auth/edge-config.ts`.

import type { NextAuthConfig } from 'next-auth';
import { isAllowedGoogleWorkspaceIdentity } from './workspace';
import { resolveSignIn } from './sign-in';
import { edgeAuthConfig } from './edge-config';
import { getRuntime } from '../booking/runtime';
import { resolveEnv } from '../env';

export { GOOGLE_CONSENT_SCOPES, googleProvider } from './edge-config';

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
  ...edgeAuthConfig,
  callbacks: {
    ...edgeAuthConfig.callbacks,
    async signIn({ profile, account }) {
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
      //
      // AC-14: the same callback persists the offline refresh token, encrypted
      // under `OAUTH_TOKEN_KEY`. It is the only moment Google ever hands it to
      // us, so dropping it here is what would leave every live call reporting
      // `host_not_connected`.
      const env = resolveEnv();
      const decision = await resolveSignIn({
        owners: getRuntime().owners,
        email: profile?.email ?? null,
        givenName: givenNameFromProfile(profile),
        refreshToken:
          typeof account?.refresh_token === 'string' ? account.refresh_token : null,
        oauthTokenKey: env.oauthTokenKey,
      });
      return decision.ok ? true : decision.redirect;
    },
  },
} satisfies NextAuthConfig;
