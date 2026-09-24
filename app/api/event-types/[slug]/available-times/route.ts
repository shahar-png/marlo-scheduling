import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { createFixtureCalendarProvider } from '@/lib/calendar/google-freebusy';
import type { CalendarProvider } from '@/lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '@/lib/calendar/google-freebusy';
import {
  COLLECTIVE,
  DEMO_OWNER_ID,
  eventTypeHostIds,
  GROUP,
  ownersOfSlug,
  resolveEventType,
  type EventType,
} from '@/lib/availability/event-type';
import { getAvailabilitySchedule } from '@/lib/availability/schedule';
import { listAvailableTimes } from '@/lib/availability/slots';
import { assertLiveKind, isFixtureOnlyKind } from '@/lib/catalog';
import {
  calendarIdsForHosts,
  extraBusyForHosts,
  hostBookingsAsBusy,
  withSpotsRemaining,
} from '@/lib/booking/booking';
import { ensureOwnerFixtures } from '@/lib/booking/fixtures';
import { availableTimes } from '@/lib/booking/service';
import { errorResponse } from '@/lib/api/route-helpers';
import { DEMO_EVENT_SLUG, ensureDemoFixtures } from '@/lib/demo/seed';
import { resolveEnv } from '@/lib/env';
import { DEMO_OWNER_SLUG } from '@/lib/owners-materialize';
import fixture from '@/tests/fixtures/google-freebusy.json';

// C2 — the legacy availability read. It answers for the `demo` owner only and
// is the exact counterpart of the legacy `POST …/bookings`, so it **must** read
// the same occupancy that POST writes. A `one_on_one` slug therefore runs the
// shared demo-scoped resolution and the shared C6.1 occupancy + C7 calendar
// classification; only `group` and `collective` keep the memory-mode fixture
// path, whose `hostBookingsAsBusy` + fixture `freeBusy` read a separate legacy
// map and would otherwise advertise a slot the shared store has already taken.

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

  // Demo seed (no-op when the slug already exists; other slugs untouched).
  if (slug === DEMO_EVENT_SLUG) {
    ensureDemoFixtures();
  }

  // (1) Read-only catalog resolution, within the demo owner only.
  const eventType = resolveEventType(DEMO_OWNER_ID, slug);
  if (!eventType) {
    const owners = ownersOfSlug(slug);
    if (owners.length > 0 && !owners.includes(DEMO_OWNER_ID)) {
      return Response.json({ error: 'owner_required' }, { status: 404 });
    }
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }

  // (2) The C6.9 kind gate, before any lock, store read, or Google call.
  try {
    assertLiveKind(eventType.kind, resolveEnv().store === 'pg');
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }

  // (3) A fixture kind keeps its existing path (C6.9); everything else reads the
  // shared occupancy, so the slot this route offers is one the shared create
  // would actually accept.
  if (isFixtureOnlyKind(eventType.kind)) {
    return legacyFixtureTimes(eventType, timeMin, timeMax);
  }

  try {
    // Inside the boundary: seeding resolves the runtime, and in pg mode that is
    // where a missing driver or an unreachable database surfaces (REV-07).
    await ensureOwnerFixtures(DEMO_OWNER_SLUG);
    const { times } = await availableTimes({
      ownerSlug: DEMO_OWNER_SLUG,
      eventSlug: slug,
      window: { start: timeMin, end: timeMax },
    });
    return Response.json({ times });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}

/** The retained memory-mode fixture path for `group` / `collective` (C6.9). */
async function legacyFixtureTimes(
  eventType: EventType,
  timeMin: string,
  timeMax: string,
): Promise<Response> {
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
