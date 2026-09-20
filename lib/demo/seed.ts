import {
  createEventType,
  getEventTypeBySlug,
  ONE_ON_ONE,
  type EventType,
} from '../availability/event-type';
import { createAvailabilitySchedule } from '../availability/schedule';

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
export const DEMO_BOOKING_PATH = `/${DEMO_HOST_SLUG}/${DEMO_EVENT_SLUG}`;

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

// Host chrome only: `[slug]` is not a backend resource this slice.
export function hostFirstNameForSlug(slug: string): string {
  if (slug === DEMO_HOST_SLUG) {
    return DEMO_HOST_FIRST_NAME;
  }
  const trimmed = slug.trim();
  return trimmed ? trimmed[0].toUpperCase() + trimmed.slice(1) : DEMO_HOST_FIRST_NAME;
}
