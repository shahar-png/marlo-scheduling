// Shared resolution for every `/api/bookings/{id}/*` route (C11).
//
// A durable row is served under the new contract: bearer authentication,
// `expectedRevision` bodies, the C3 envelope. A legacy in-memory fixture row
// (the retained `/api/event-types/{slug}/*` and `/api/links/*` paths, which C10
// and C6.9 keep explicitly outside the C6 contract) is served by its existing
// handler, so those fixtures keep their semantics unchanged.

import { getBooking, type Booking as LegacyBooking } from '../booking/booking';
import { getRuntime } from '../booking/runtime';
import { scopeForRow, type BookingScope } from '../booking/service';
import type { BookingRow } from '../booking/rows';
import { requireBookingToken } from './route-helpers';

export type Resolution =
  | { kind: 'durable'; row: BookingRow }
  /** A retained memory-mode fixture row that **actually exists** (C10/C6.9). */
  | { kind: 'legacy'; booking: LegacyBooking }
  /** Nothing under this id anywhere: authenticated like every other id (C11). */
  | { kind: 'missing' };

/**
 * C11 — an id that resolves to no row must not be distinguishable from one that
 * does. Treating *every* durable miss as "legacy" made the routes answer 401 for
 * an existing durable id and 404 for an unknown one without a bearer, and two
 * different error strings with a wrong bearer — a booking-existence oracle
 * (REV-08). `legacy` now means a fixture row that is really there; everything
 * else is `missing` and goes through the same nullable-row bearer check, which
 * answers 401 `token_required` without a header and a uniform 404
 * `booking_not_found` with one.
 */
export async function resolveBookingId(id: string): Promise<Resolution> {
  const row = await getRuntime().store.getById(id);
  if (row !== null) {
    return { kind: 'durable', row };
  }
  const legacy = getBooking(id);
  return legacy ? { kind: 'legacy', booking: legacy } : { kind: 'missing' };
}

/** The durable row when there is one; `null` otherwise — never an oracle. */
export function durableRowOf(resolved: Resolution): BookingRow | null {
  return resolved.kind === 'durable' ? resolved.row : null;
}

/** Durable rows only: authenticate the bearer token, then build the scope. */
export async function authorizedScope(
  request: Request,
  row: BookingRow | null,
): Promise<BookingScope> {
  const authenticated = requireBookingToken(request, row);
  return scopeForRow(authenticated);
}
