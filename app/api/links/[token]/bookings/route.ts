import { getSingleUseLinkByToken } from '@/lib/availability/single-use-link';
import {
  BookingConflictError,
  BookingNotFoundError,
  BookingValidationError,
  bookSingleUseLink,
  SingleUseLinkConsumedError,
} from '@/lib/booking/booking';
import {
  getBookingCalendarProvider,
  setBookingCalendarProvider,
} from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';

export { setBookingCalendarProvider };

type BookingBody = {
  start?: unknown;
  invitee?: {
    name?: unknown;
    email?: unknown;
  };
};

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;

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

  const link = getSingleUseLinkByToken(token);
  const connection = link ? getHostCalendarConnection(link.hostId) : null;
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  try {
    const booking = await bookSingleUseLink({
      token,
      start,
      invitee: { name, email },
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
    if (error instanceof SingleUseLinkConsumedError) {
      return Response.json({ error: error.message }, { status: 410 });
    }
    throw error;
  }
}
