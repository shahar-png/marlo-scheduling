import { getEventType } from '@/lib/availability/event-type';
import {
  BookingConflictError,
  BookingNotFoundError,
  BookingValidationError,
  rescheduleBooking as rescheduleLegacyBooking,
  type Booking as LegacyBooking,
} from '@/lib/booking/booking';
import { getBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { rescheduleBooking } from '@/lib/booking/service';
import { authorizedScope, durableRowOf, resolveBookingId } from '@/lib/api/booking-routes';
import { errorResponse, originOf, readJsonBody } from '@/lib/api/route-helpers';

// C2 / C6.6 — `POST /api/bookings/{id}/reschedule`, token-authenticated, body
// `{ start, expectedRevision }`; a revision mismatch is 409 `booking_changed`.
//
// A legacy in-memory fixture row keeps its existing handler (outside the C6
// contract, C6.9/C10).

export const dynamic = 'force-dynamic';

type Body = { start?: unknown; expectedRevision?: unknown };

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = await readJsonBody<Body>(request);
  if (body === null) {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }
  const start = typeof body.start === 'string' ? body.start : '';
  if (!start) {
    return Response.json({ error: 'start is required' }, { status: 400 });
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
      const outcome = await rescheduleBooking(scope, {
        start,
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

  return legacyReschedule(id, start, resolved.booking);
}

async function legacyReschedule(
  id: string,
  start: string,
  existing: LegacyBooking,
): Promise<Response> {
  const eventType = getEventType(existing.eventTypeId);
  const connection = eventType ? getHostCalendarConnection(eventType.hostId) : null;
  const calendarId = connection?.destinationCalendarId ?? 'primary';
  try {
    const booking = await rescheduleLegacyBooking({
      bookingId: id,
      start,
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
    if (error instanceof BookingConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
