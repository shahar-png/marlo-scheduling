import { getEventType } from '@/lib/availability/event-type';
import {
  BookingNotFoundError,
  BookingValidationError,
  cancelBooking,
  getBooking,
} from '@/lib/booking/booking';
import { getBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';

type CancelBody = {
  reason?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;

  let body: CancelBody;
  try {
    body = (await request.json()) as CancelBody;
  } catch {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
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
  const connection = eventType
    ? getHostCalendarConnection(eventType.hostId)
    : null;
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  try {
    const booking = await cancelBooking({
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
