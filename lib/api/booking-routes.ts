// Shared resolution for every `/api/bookings/{id}/*` route (C11).
//
// A durable row is served under the new contract: bearer authentication,
// `expectedRevision` bodies, the C3 envelope. A legacy in-memory fixture row
// (the retained `/api/event-types/{slug}/*` and `/api/links/*` paths, which C10
// and C6.9 keep explicitly outside the C6 contract) is served by its existing
// handler, so those fixtures keep their semantics unchanged.

import { getRuntime } from '../booking/runtime';
import { scopeForRow, type BookingScope } from '../booking/service';
import type { BookingRow } from '../booking/rows';
import { requireBookingToken } from './route-helpers';

export type Resolution =
  | { kind: 'durable'; row: BookingRow }
  | { kind: 'legacy' };

export async function resolveBookingId(id: string): Promise<Resolution> {
  const row = await getRuntime().store.getById(id);
  return row === null ? { kind: 'legacy' } : { kind: 'durable', row };
}

/** Durable rows only: authenticate the bearer token, then build the scope. */
export async function authorizedScope(
  request: Request,
  row: BookingRow | null,
): Promise<BookingScope> {
  const authenticated = requireBookingToken(request, row);
  return scopeForRow(authenticated);
}
