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
    await materializeOwner(input.owners, {
      slug,
      firstName:
        typeof input.givenName === 'string' && input.givenName.trim() !== ''
          ? input.givenName.trim()
          : slug,
      email,
    });
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
