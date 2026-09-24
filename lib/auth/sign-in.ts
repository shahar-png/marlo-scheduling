// C1 / AC-2 — host sign-in materializes the owner.
//
// The owner slug is the validated local-part of the Google address. A local-part
// that is an application-owned root segment fails the sign-in with
// `owner_slug_reserved` **before any `owners` or `host_tokens` write**
// (REV5-06); a local-part already taken by a different owner fails with
// `owner_slug_taken` rather than being silently suffixed.

import {
  OwnerSlugTakenError,
  ReservedOwnerSlugError,
  isReservedRootSlug,
  ownerSlugFromEmail,
  type OwnerStore,
} from '../owners';
import { materializeOwner } from '../owners-materialize';
import { encryptRefreshToken } from '../google/oauth';

export const SIGN_IN_ERRORS = {
  reserved: '/signin?error=owner_slug_reserved',
  taken: '/signin?error=owner_slug_taken',
  invalid: '/signin?error=owner_slug_invalid',
} as const;

export type SignInDecision = { ok: true; ownerSlug: string } | { ok: false; redirect: string };

export async function resolveSignIn(input: {
  owners: OwnerStore;
  email: string | null | undefined;
  givenName: string | null | undefined;
  /**
   * AC-14 — the offline refresh token Google returns on the consent that
   * carried `access_type=offline` + `prompt=consent`. It is stored **encrypted**
   * under `OAUTH_TOKEN_KEY`; without it the live adapters can only report
   * `host_not_connected`.
   */
  refreshToken?: string | null;
  oauthTokenKey?: string | null;
}): Promise<SignInDecision> {
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  if (email === '') {
    return { ok: false, redirect: SIGN_IN_ERRORS.invalid };
  }
  const slug = ownerSlugFromEmail(email);
  if (slug === null) {
    return { ok: false, redirect: SIGN_IN_ERRORS.invalid };
  }
  if (isReservedRootSlug(slug)) {
    // Refused before any write.
    return { ok: false, redirect: SIGN_IN_ERRORS.reserved };
  }
  try {
    const { owner } = await materializeOwner(input.owners, {
      slug,
      firstName:
        typeof input.givenName === 'string' && input.givenName.trim() !== ''
          ? input.givenName.trim()
          : slug,
      email,
    });
    // Google returns a refresh token only on a consent that asked for offline
    // access. A re-consent that returns none must not wipe the stored one.
    const refreshToken =
      typeof input.refreshToken === 'string' && input.refreshToken.trim() !== ''
        ? input.refreshToken.trim()
        : null;
    if (refreshToken !== null && input.oauthTokenKey) {
      await input.owners.putHostToken({
        ownerId: owner.id,
        refreshTokenEnc: encryptRefreshToken(refreshToken, input.oauthTokenKey),
        updatedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    if (error instanceof ReservedOwnerSlugError) {
      return { ok: false, redirect: SIGN_IN_ERRORS.reserved };
    }
    if (error instanceof OwnerSlugTakenError) {
      return { ok: false, redirect: SIGN_IN_ERRORS.taken };
    }
    throw error;
  }
  return { ok: true, ownerSlug: slug };
}
