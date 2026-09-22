import { getEventType } from '@/lib/availability/event-type';
import {
  BookingNotFoundError,
  BookingValidationError,
  cancelBooking as cancelLegacyBooking,
  getBooking,
} from '@/lib/booking/booking';
import { getBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { cancelBooking } from '@/lib/booking/service';
import { authorizedScope, resolveBookingId } from '@/lib/api/booking-routes';
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
  if (resolved.kind === 'durable') {
    if (
      typeof body.expectedRevision !== 'number' ||
      !Number.isInteger(body.expectedRevision)
    ) {
      return Response.json({ error: 'expectedRevision is required' }, { status: 400 });
    }
    try {
      const scope = await authorizedScope(request, resolved.row);
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
  const existing = getBooking(id);
  if (!existing) {
    return Response.json({ error: 'booking not found' }, { status: 404 });
  }
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
