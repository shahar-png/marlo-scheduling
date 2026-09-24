import { getEventType } from '../availability/event-type';
import { getBooking } from '../booking/booking';
import { hostMetaForHostId } from '../demo/seed';
import { mapBooking } from './client';
import { publicBookingPath } from './public-path';
import { getRuntime } from '../booking/runtime';
import { readBooking, scopeForRow } from '../booking/service';
import type { ConfirmedPublicBooking, PublicBookingResult } from './types';

// Server-side helper for the confirmation shell: reads the existing in-memory
// booking row directly (no HTTP round trip from a Server Component to itself).
// Returns null when the row is missing (e.g. another serverless isolate); the
// page still renders the branded shell for that token.
//
// Host chrome (BOOK-FE-15/17): the host is resolved FIRST, from the row's
// `hostId` through the canonical `hostMetaForHostId` — never from a URL and
// never with a demo-name fallback. The shared booking store is not demo-only
// (a `host-2` row can be booked through `bookAvailableSlot` and retained by
// `cancelBooking`), so an unresolvable host yields an explicit
// `unsupported_host` result carrying nothing the page could attribute,
// whatever the row's `status`.
//
// Book-again destination (BOOK-FE-14/19/20): this adapter is the only place
// that turns `booking.eventTypeId` into a URL. `bookAgainHref` is attached iff
// the canonical host, a store-backed event type, and a representable path
// (public-path.ts) all resolve — independent of `status`. A one-off booking
// made through `bookSingleUseLink` carries a synthetic `eventTypeFromOneOff`
// type that is never inserted into the store (no href); a store-backed slug
// the constructor rejects (`intro#follow-up`) yields none either — never a
// guessed `/one-off-…` path, the raw id, `#`, or a misparsed slug.
/**
 * C11 — the durable `/b/{token}` lookup.
 *
 * The page passes its path segment straight through to `getByToken`, which
 * reads the `token` column; a booking **id** in the `/b/` path therefore finds
 * nothing and renders the not-found shell, because the id alone grants nothing.
 *
 * Returns `null` when no durable row carries this token, so the caller can fall
 * back to the retained fixture adapter below (C10 / C6.9 keep those rows
 * outside the C6 contract).
 */
export async function getDurableBookingByToken(
  token: string,
): Promise<ConfirmedPublicBooking | null> {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const runtime = getRuntime();
  const row = await runtime.store.getByToken(trimmed);
  if (row === null) {
    return null;
  }
  // A read is one of the designated observing calls for the C6.3a reap, and it
  // is the only place the envelope's `pending` calendar state can surface.
  const scope = await scopeForRow(row, runtime);
  const envelope = await readBooking(scope);
  const href = publicBookingPath(scope.owner.slug, scope.eventType.slug);
  return {
    kind: 'booking',
    id: envelope.booking.id,
    token: envelope.booking.token,
    start: envelope.booking.start,
    end: envelope.booking.end,
    status: envelope.booking.status,
    eventTypeId: envelope.booking.eventTypeId,
    invitee: envelope.booking.invitee,
    ownerSlug: envelope.booking.ownerSlug,
    eventSlug: envelope.booking.eventSlug,
    revision: envelope.booking.revision,
    hostFirstName: envelope.booking.hostFirstName,
    delivery: {
      email: envelope.delivery.email,
      calendar: envelope.delivery.calendar,
    },
    ...(href ? { bookAgainHref: href } : {}),
  };
}

export function getBookingByToken(token: string): PublicBookingResult {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  const row = getBooking(trimmed);
  const booking = mapBooking(row);
  if (!row || !booking) {
    return null;
  }
  const host = hostMetaForHostId(row.hostId);
  if (!host) {
    return { kind: 'unsupported_host' };
  }
  const eventType = booking.eventTypeId ? getEventType(booking.eventTypeId) : null;
  const href = eventType ? publicBookingPath(host.slug, eventType.slug) : null;
  return {
    ...booking,
    kind: 'booking',
    hostFirstName: host.firstName,
    ...(href ? { bookAgainHref: href } : {}),
  };
}
