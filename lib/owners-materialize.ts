// C1 — owner materialization.
//
// `ensureDemoFixtures()` and the OAuth callback both go through
// `materializeOwner()`, which upserts the owner and its fixture-defined event
// types and schedule under the **deterministic C1 ids**, so re-seeding in a
// fresh isolate reproduces them and a persisted booking always resolves its
// `eventTypeId` / `scheduleId`.
//
// Only `kind='one_on_one'` is ever materialized (Product bar lock / C6.9).

import {
  createEventType,
  ONE_ON_ONE,
  resolveEventType,
  type EventType,
} from './availability/event-type';
import {
  createAvailabilitySchedule,
  getAvailabilitySchedule,
} from './availability/schedule';
import {
  assertAssignableOwnerSlug,
  eventTypeIdFor,
  ownerIdForSlug,
  scheduleIdFor,
  type Owner,
  type OwnerStore,
} from './owners';

export const DEMO_OWNER_SLUG = 'demo';
export const DEMO_EVENT_SLUG = 'intro-30';
export const DEMO_OWNER_FIRST_NAME = 'Marlo';
export const DEMO_OWNER_EMAIL = 'demo@example.com';
export const DEMO_EVENT_NAME = 'Intro call';
export const DEMO_DURATION_MINUTES = 30;
export const DEFAULT_SCHEDULE_KEY = 'default';

const WEEKDAYS = [1, 2, 3, 4, 5];

export type FixtureEventType = {
  slug: string;
  name: string;
  durationMinutes: number;
  notificationMode?: 'calendar_invitation' | 'email_confirmation';
};

/** The fixture-defined catalog every owner gets at sign-in (Non-goals: no CRUD). */
export const FIXTURE_EVENT_TYPES: readonly FixtureEventType[] = [
  {
    slug: DEMO_EVENT_SLUG,
    name: DEMO_EVENT_NAME,
    durationMinutes: DEMO_DURATION_MINUTES,
    notificationMode: 'email_confirmation',
  },
];

export type MaterializeInput = {
  slug: string;
  firstName: string;
  email: string;
  calendarId?: string;
};

export type MaterializedOwner = {
  owner: Owner;
  eventTypes: EventType[];
};

export async function materializeOwner(
  owners: OwnerStore,
  input: MaterializeInput,
): Promise<MaterializedOwner> {
  // Throws `ReservedOwnerSlugError` before any write (REV5-06).
  const slug = assertAssignableOwnerSlug(input.slug);
  const owner = await owners.upsert({
    id: ownerIdForSlug(slug),
    slug,
    firstName: input.firstName,
    email: input.email,
    calendarId: input.calendarId ?? 'primary',
  });

  const scheduleId = scheduleIdFor(slug, DEFAULT_SCHEDULE_KEY);
  const windows = WEEKDAYS.map((weekday) => ({
    weekday,
    start: '09:00',
    end: '20:00',
  }));
  if (getAvailabilitySchedule(scheduleId) === null) {
    createAvailabilitySchedule({
      id: scheduleId,
      // The host id IS the owner id in this slice: one host per owner.
      hostId: owner.id,
      timezone: 'UTC',
      windows,
    });
  }
  // …and durably, through the same store the catalog reads. In memory mode this
  // is a no-op; in pg mode it is what makes the owner resolvable at all (C1).
  await owners.upsertSchedule({
    id: scheduleId,
    ownerId: owner.id,
    timezone: 'UTC',
    windows,
  });

  const eventTypes: EventType[] = [];
  for (const fixture of FIXTURE_EVENT_TYPES) {
    const existing = resolveEventType(owner.id, fixture.slug);
    const eventType =
      existing ??
      createEventType({
        id: eventTypeIdFor(slug, fixture.slug),
        ownerId: owner.id,
        hostId: owner.id,
        slug: fixture.slug,
        name: fixture.name,
        durationMinutes: fixture.durationMinutes,
        availabilityScheduleId: scheduleId,
        // Product bar lock: only `one_on_one` is ever materialized.
        kind: ONE_ON_ONE,
        ...(fixture.notificationMode === undefined
          ? {}
          : { notificationMode: fixture.notificationMode }),
      });
    eventTypes.push(eventType);
    await owners.upsertEventType({
      id: eventType.id,
      ownerId: owner.id,
      slug: eventType.slug,
      name: eventType.name,
      durationMinutes: eventType.durationMinutes,
      scheduleId: eventType.availabilityScheduleId,
      notificationMode: eventType.notificationMode,
    });
  }

  return { owner, eventTypes };
}

export async function ensureDemoOwner(owners: OwnerStore): Promise<MaterializedOwner> {
  return materializeOwner(owners, {
    slug: DEMO_OWNER_SLUG,
    firstName: DEMO_OWNER_FIRST_NAME,
    email: DEMO_OWNER_EMAIL,
    calendarId: 'primary',
  });
}

export const DEMO_OWNER_ID = ownerIdForSlug(DEMO_OWNER_SLUG);
export const DEMO_EVENT_TYPE_ID = eventTypeIdFor(DEMO_OWNER_SLUG, DEMO_EVENT_SLUG);
export const DEMO_SCHEDULE_ID = scheduleIdFor(DEMO_OWNER_SLUG, DEFAULT_SCHEDULE_KEY);
