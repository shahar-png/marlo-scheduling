import { getSingleUseLinkByToken } from '@/lib/availability/single-use-link';
import {
  BookingNotFoundError,
  listSingleUseAvailableTimes,
  SingleUseLinkConsumedError,
} from '@/lib/booking/booking';
import { getBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const url = new URL(request.url);
  const timeMin = url.searchParams.get('timeMin');
  const timeMax = url.searchParams.get('timeMax');

  if (!timeMin || !timeMax) {
    return Response.json(
      { error: 'timeMin and timeMax are required' },
      { status: 400 },
    );
  }

  const link = getSingleUseLinkByToken(token);
  const connection = link ? getHostCalendarConnection(link.hostId) : null;
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  try {
    const times = await listSingleUseAvailableTimes({
      token,
      timeMin,
      timeMax,
      provider: getBookingCalendarProvider(),
      calendarId,
    });
    return Response.json({ times });
  } catch (error) {
    if (error instanceof SingleUseLinkConsumedError) {
      return Response.json({ error: error.message }, { status: 410 });
    }
    if (error instanceof BookingNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    throw error;
  }
}
