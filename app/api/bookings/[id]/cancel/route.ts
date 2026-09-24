import { getEventType } from '@/lib/availability/event-type';
import {
  BookingNotFoundError,
  BookingValidationError,
  cancelBooking as cancelLegacyBooking,
} from '@/lib/booking/booking';
import { getBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { cancelBooking } from '@/lib/booking/service';
import { authorizedScope, durableRowOf, resolveBookingId } from '@/lib/api/booking-routes';
import { errorResponse, originOf, readJsonBody } from '@/lib/api/route-helpers';

// C2 / C6.7 — `POST /api/bookings/{id}/cancel`, token-authenticated, body
// `{ expectedRevision }`. Cancel never runs while a reschedule owns
// `pending_op` (409 `operation_in_progress`) and never undoes one.
//
// A legacy in-memory fixture row keeps its existing reason-based handler.

export const dynamic = 'force-dynamic';

type Body = { expectedRevision?: unknown; reason?: unknown };

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await readJsonBody<Body>(request);
  if (body === null) {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }

  const resolved = await resolveBookingId(id);
  // Only an **existing** fixture row takes the legacy path; every other id —
  // durable or unknown — goes through the same bearer check, so the response
  // never reveals whether the booking exists (C11 — REV-08).
  if (resolved.kind !== 'legacy') {
    try {
      // Authentication first: a body check that ran before it would answer 400
      // for an unknown id and 401 for a real one, which is the same oracle in a
      // different shape (C11 — REV-08).
      const scope = await authorizedScope(request, durableRowOf(resolved));
      if (
        typeof body.expectedRevision !== 'number' ||
        !Number.isInteger(body.expectedRevision)
      ) {
        return Response.json({ error: 'expectedRevision is required' }, { status: 400 });
      }
      const outcome = await cancelBooking(scope, {
        expectedRevision: body.expectedRevision,
        origin: originOf(request),
      });
      return Response.json(outcome.envelope, { status: 200 });
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped !== null) {
        return mapped;
      }
      throw error;
    }
  }

  const reason = typeof body.reason === 'string' ? body.reason : '';
  if (!reason.trim()) {
    return Response.json({ error: 'reason is required' }, { status: 400 });
  }
  const existing = resolved.booking;
  const eventType = getEventType(existing.eventTypeId);
  const connection = eventType ? getHostCalendarConnection(eventType.hostId) : null;
  const calendarId = connection?.destinationCalendarId ?? 'primary';
  try {
    const booking = await cancelLegacyBooking({
      bookingId: id,
      reason,
      provider: getBookingCalendarProvider(),
      calendarId,
    });
    return Response.json({ booking }, { status: 200 });
  } catch (error) {
    if (error instanceof BookingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof BookingNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
