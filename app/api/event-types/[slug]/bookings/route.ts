import { getEventTypeBySlug } from '@/lib/availability/event-type';
import {
  bookAvailableSlot,
  BookingConflictError,
  BookingNotFoundError,
  BookingValidationError,
} from '@/lib/booking/booking';
import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { createFixtureCalendarProvider } from '@/lib/calendar/google-freebusy';
import type { CalendarProvider } from '@/lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '@/lib/calendar/google-freebusy';
import fixture from '@/tests/fixtures/google-freebusy.json';

let injectedProvider: CalendarProvider | null = null;

export function setBookingCalendarProvider(
  provider: CalendarProvider | null,
): void {
  injectedProvider = provider;
}

function getCalendarProvider(): CalendarProvider {
  return (
    injectedProvider ??
    createFixtureCalendarProvider(fixture as GoogleFreeBusyFixture)
  );
}

type BookingBody = {
  start?: unknown;
  invitee?: {
    name?: unknown;
    email?: unknown;
  };
};

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;

  let body: BookingBody;
  try {
    body = (await request.json()) as BookingBody;
  } catch {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }

  const start = typeof body.start === 'string' ? body.start : '';
  const name = typeof body.invitee?.name === 'string' ? body.invitee.name : '';
  const email =
    typeof body.invitee?.email === 'string' ? body.invitee.email : '';

  if (!start || !name || !email) {
    return Response.json(
      { error: 'start and invitee name/email are required' },
      { status: 400 },
    );
  }

  const eventType = getEventTypeBySlug(slug);
  if (!eventType) {
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }

  const connection = getHostCalendarConnection(eventType.hostId);
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  try {
    const booking = await bookAvailableSlot({
      eventType,
      start,
      invitee: { name, email },
      provider: getCalendarProvider(),
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
