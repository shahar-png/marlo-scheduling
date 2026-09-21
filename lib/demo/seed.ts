import {
  createEventType,
  getEventTypeBySlug,
  ONE_ON_ONE,
  type EventType,
} from '../availability/event-type';
import { createAvailabilitySchedule } from '../availability/schedule';
import { publicBookingPath } from '../api/public-path';

// Demo fixtures so Production (in-memory store, serverless isolates) is never
// empty: `/demo/intro-30` is always bookable. Seeded only when the slug is
// missing — never from resetEventTypes(), so tests that reset and seed their
// own `intro-30` keep their fixture semantics.

export const DEMO_HOST_SLUG = 'demo';
export const DEMO_EVENT_SLUG = 'intro-30';
export const DEMO_HOST_ID = 'host-1';
export const DEMO_HOST_FIRST_NAME = 'Marlo';
export const DEMO_EVENT_NAME = 'Intro call';
export const DEMO_DURATION_MINUTES = 30;
// Built through the shared constructor (BOOK-FE-19); both segments are
// representable constants, so the result is always a string.
export const DEMO_BOOKING_PATH = publicBookingPath(DEMO_HOST_SLUG, DEMO_EVENT_SLUG) as string;

const WEEKDAYS = [1, 2, 3, 4, 5];

export function ensureDemoFixtures(): EventType {
  const existing = getEventTypeBySlug(DEMO_EVENT_SLUG);
  if (existing) {
    return existing;
  }
  const schedule = createAvailabilitySchedule({
    hostId: DEMO_HOST_ID,
    timezone: 'UTC',
    windows: WEEKDAYS.map((weekday) => ({
      weekday,
      start: '09:00',
      end: '20:00',
    })),
  });
  return createEventType({
    hostId: DEMO_HOST_ID,
    slug: DEMO_EVENT_SLUG,
    name: DEMO_EVENT_NAME,
    durationMinutes: DEMO_DURATION_MINUTES,
    availabilityScheduleId: schedule.id,
    kind: ONE_ON_ONE,
  });
}

// Canonical host metadata (BOOK-FE-15). Keyed by the event type's / booking
// row's `hostId` — the thing a booking actually targets — never by URL text.
// This slice has exactly one public host; anything else resolves to `null`
// (no host directory, no name derived from a URL segment).
export type HostMeta = {
  id: string;
  slug: string;
  firstName: string;
};

export function hostMetaForHostId(hostId: string): HostMeta | null {
  if (hostId === DEMO_HOST_ID) {
    return { id: DEMO_HOST_ID, slug: DEMO_HOST_SLUG, firstName: DEMO_HOST_FIRST_NAME };
  }
  return null;
}
