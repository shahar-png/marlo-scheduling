import { getEventType } from '../availability/event-type';
import { getBooking } from '../booking/booking';
import { hostMetaForHostId } from '../demo/seed';
import { mapBooking } from './client';
import { publicBookingPath } from './public-path';
import type { PublicBookingResult } from './types';

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
