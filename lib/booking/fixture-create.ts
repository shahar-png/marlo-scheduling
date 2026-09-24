// C6.9 / C2 — the retained memory-mode fixture create for `group` (capacity-N)
// and `collective` event types.
//
// Those kinds are **outside** the C6 lifecycle and the C9 idempotency contract
// (Product bar lock §1): they carry no key, no `create_fingerprint`, no
// `(owner_id, idempotency_key)` record, and no `create_rejections` fence. Every
// create entry point — owner-scoped, legacy `demo`, and the C10 link route —
// dispatches here immediately after the read-only catalog resolution and the
// C6.9 kind gate, and therefore **before** the `Idempotency-Key` check, which is
// exactly what keeps `tests/group-route.test.ts` and
// `tests/collective-route.test.ts` (whose helpers send only `content-type`)
// passing byte-for-byte unmodified (REV15-03, AC-24(f)).
//
// It lives beside the lifecycle rather than inside `service.ts` so the shared
// create path cannot reach `bookAvailableSlot`: `lib/booking/booking.ts` already
// imports `service.ts` for the C10 link create, and the reverse import would be
// a module cycle.

import type { EventType } from '../availability/event-type';
import {
  bookAvailableSlot,
  BookingConflictError,
  BookingNotFoundError,
  BookingValidationError,
} from './booking';
import { getBookingCalendarProvider } from './calendar-runtime';
import { getHostCalendarConnection } from '../calendar/connection';

export type FixtureBookingInput = {
  eventType: EventType;
  start: string;
  invitee: { name: string; email: string };
};

/** The existing fixture path, with its existing wire codes (201/400/404/409). */
export async function fixtureCreateResponse(
  input: FixtureBookingInput,
): Promise<Response> {
  const connection = getHostCalendarConnection(input.eventType.hostId);
  const calendarId = connection?.destinationCalendarId ?? 'primary';
  try {
    const booking = await bookAvailableSlot({
      eventType: input.eventType,
      start: input.start,
      invitee: input.invitee,
      provider: getBookingCalendarProvider(),
      calendarId,
    });
    return Response.json({ booking }, { status: 201 });
  } catch (error) {
    if (error instanceof BookingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof BookingNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof BookingConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
