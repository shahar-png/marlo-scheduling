import { getEventType } from '@/lib/availability/event-type';
import {
  BookingConflictError,
  BookingNotFoundError,
  BookingValidationError,
  getBooking,
  rescheduleBooking,
} from '@/lib/booking/booking';
import { getBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';

type RescheduleBody = {
  start?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let body: RescheduleBody;
  try {
    body = (await request.json()) as RescheduleBody;
  } catch {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }

  const start = typeof body.start === 'string' ? body.start : '';
  if (!start) {
    return Response.json({ error: 'start is required' }, { status: 400 });
  }

  const existing = getBooking(id);
  if (!existing) {
    return Response.json({ error: 'booking not found' }, { status: 404 });
  }

  const eventType = getEventType(existing.eventTypeId);
  const connection = eventType
    ? getHostCalendarConnection(eventType.hostId)
    : null;
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  try {
    const booking = await rescheduleBooking({
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
