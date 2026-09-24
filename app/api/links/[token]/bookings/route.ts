import { getSingleUseLinkByToken } from '@/lib/availability/single-use-link';
import {
  BookingNotFoundError,
  BookingValidationError,
  bookSingleUseLink,
  SingleUseLinkConsumedError,
} from '@/lib/booking/booking';
import {
  getBookingCalendarProvider,
  setBookingCalendarProvider,
} from '@/lib/booking/calendar-runtime';
import { IdempotencyKeyReusedError } from '@/lib/booking/errors';
import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { resolveEnv } from '@/lib/env';
import { errorResponse } from '@/lib/api/route-helpers';

export { setBookingCalendarProvider };

// C10 — links and one-off meetings are not durable records. In pg/live mode
// both link routes return 501 `links_not_supported` as the **first** statement
// of the handler: before the link lookup, any store query, calendar call, or
// email (AC-22). In memory mode they stay fixture-only.

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
  if (resolveEnv().store === 'pg') {
    return Response.json({ error: 'links_not_supported' }, { status: 501 });
  }

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
    // The C9 key is `link:{token}`, so a consumed link is resolved by the
    // stored fingerprint: identical payload → the original booking, 201.
    const outcome = await bookSingleUseLink({
      token,
      start,
      invitee: { name, email },
      provider: getBookingCalendarProvider(),
      calendarId,
    });
    return Response.json(outcome.envelope, { status: 201 });
  } catch (error) {
    if (error instanceof BookingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof BookingNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    // C10 — the key is the link, so "this key was reused with a different
    // payload" *is* "this link is spent": 422 becomes the link contract's 410.
    if (
      error instanceof IdempotencyKeyReusedError ||
      error instanceof SingleUseLinkConsumedError
    ) {
      return Response.json(
        { error: new SingleUseLinkConsumedError().message },
        { status: 410 },
      );
    }
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}
