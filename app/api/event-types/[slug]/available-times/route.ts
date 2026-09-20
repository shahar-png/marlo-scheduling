import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { createFixtureCalendarProvider } from '@/lib/calendar/google-freebusy';
import type { CalendarProvider } from '@/lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '@/lib/calendar/google-freebusy';
import {
  COLLECTIVE,
  eventTypeHostIds,
  getEventTypeBySlug,
  GROUP,
} from '@/lib/availability/event-type';
import { getAvailabilitySchedule } from '@/lib/availability/schedule';
import { listAvailableTimes } from '@/lib/availability/slots';
import {
  calendarIdsForHosts,
  extraBusyForHosts,
  hostBookingsAsBusy,
  withSpotsRemaining,
} from '@/lib/booking/booking';
import fixture from '@/tests/fixtures/google-freebusy.json';

let injectedProvider: CalendarProvider | null = null;

export function setAvailableTimesCalendarProvider(
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

export async function GET(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;
  const url = new URL(request.url);
  const timeMin = url.searchParams.get('timeMin');
  const timeMax = url.searchParams.get('timeMax');

  if (!timeMin || !timeMax) {
    return Response.json(
      { error: 'timeMin and timeMax are required' },
      { status: 400 },
    );
  }

  const eventType = getEventTypeBySlug(slug);
  if (!eventType) {
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }

  const schedule = getAvailabilitySchedule(eventType.availabilityScheduleId);
  if (!schedule) {
    return Response.json(
      { error: 'availability schedule not found' },
      { status: 404 },
    );
  }

  const hostIds = eventTypeHostIds(eventType);
  const connection = getHostCalendarConnection(eventType.hostId);
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  const extraBusy =
    eventType.kind === COLLECTIVE
      ? extraBusyForHosts(hostIds)
      : hostBookingsAsBusy(
          eventType.hostId,
          eventType.kind === GROUP
            ? { excludeEventTypeId: eventType.id }
            : undefined,
        );

  const times = await listAvailableTimes({
    eventType,
    schedule,
    timeMin,
    timeMax,
    provider: getCalendarProvider(),
    calendarId,
    calendarIds:
      eventType.kind === COLLECTIVE ? calendarIdsForHosts(hostIds) : undefined,
    extraBusy,
  });

  if (eventType.kind === GROUP) {
    return Response.json({ times: withSpotsRemaining(times, eventType) });
  }

  return Response.json({ times });
}
