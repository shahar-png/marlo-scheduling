import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  createEventType,
  getEventType,
  getEventTypeBySlug,
  resetEventTypes,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import {
  listAvailableTimes,
  listAvailableTimesWithCapacity,
} from '../lib/availability/slots';
import {
  bookAvailableSlot,
  BookingConflictError,
  countConfirmedBookingsForSlot,
  hostBookingsAsBusy,
  listConfirmedBookingsForHost,
  listConfirmedStartsForEventType,
  resetBookings,
  SESSION_FULL,
  SLOT_UNAVAILABLE,
} from '../lib/booking/booking';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { CalendarProvider } from '../lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
    'utf8',
  ),
) as GoogleFreeBusyFixture;

const SLOT_0900 = '2026-09-20T09:00:00.000Z';
const SLOT_0930 = '2026-09-20T09:30:00.000Z';
const SLOT_1400 = '2026-09-20T14:00:00.000Z';
const OUTSIDE = '2026-09-20T08:00:00.000Z';
const RANGE_MIN = '2026-09-20T00:00:00.000Z';
const RANGE_MAX = '2026-09-21T00:00:00.000Z';

function seedSundaySchedule() {
  return createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
}

function seedGroup(maxInvitees = 2, slug = 'group-30') {
  const schedule = seedSundaySchedule();
  return createEventType({
    hostId: 'host-1',
    slug,
    name: 'Group workshop',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'group',
    maxInvitees,
  });
}

function seedOneOnOne(slug = 'intro-30') {
  const schedule = seedSundaySchedule();
  return createEventType({
    hostId: 'host-1',
    slug,
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'one_on_one',
  });
}

function delayedFixtureProvider(delayMs = 25): CalendarProvider {
  const inner = createFixtureCalendarProvider(FIXTURE);
  return {
    createdEvents: inner.createdEvents,
    async freeBusy(query) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return inner.freeBusy(query);
    },
    createEvent: (event) => inner.createEvent(event),
    updateEvent: (event) => inner.updateEvent(event),
    deleteEvent: (event) => inner.deleteEvent(event),
  } as CalendarProvider & { createdEvents: typeof inner.createdEvents };
}

async function groupTimes(eventType: ReturnType<typeof seedGroup>) {
  const schedule = {
    id: eventType.availabilityScheduleId,
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  };
  return listAvailableTimesWithCapacity({
    eventType,
    schedule,
    timeMin: RANGE_MIN,
    timeMax: RANGE_MAX,
    provider: createFixtureCalendarProvider(FIXTURE),
    calendarId: 'primary',
    extraBusy: hostBookingsAsBusy(eventType.hostId, {
      excludeEventTypeId: eventType.id,
    }),
    maxInvitees: eventType.maxInvitees!,
    confirmedStarts: listConfirmedStartsForEventType(eventType.id),
  });
}

describe('AC-1 group event-type stub', () => {
  beforeEach(() => {
    resetEventTypes();
    resetAvailabilitySchedules();
  });

  it('creates and reads a group event type with maxInvitees', () => {
    const created = seedGroup(3, 'workshop');

    assert.equal(created.kind, 'group');
    assert.equal(created.maxInvitees, 3);
    assert.equal(created.slug, 'workshop');
    assert.deepEqual(getEventType(created.id), created);
    assert.deepEqual(getEventTypeBySlug('workshop'), created);
  });

  it('rejects missing, zero, or non-integer maxInvitees on a group type', () => {
    const schedule = seedSundaySchedule();
    const base = {
      hostId: 'host-1',
      name: 'Group workshop',
      durationMinutes: 30,
      availabilityScheduleId: schedule.id,
      kind: 'group' as const,
    };

    assert.throws(
      () => createEventType({ ...base, slug: 'missing-max' }),
      /maxInvitees must be a positive integer/,
    );
    assert.throws(
      () =>
        createEventType({ ...base, slug: 'zero-max', maxInvitees: 0 }),
      /maxInvitees must be a positive integer/,
    );
    assert.throws(
      () =>
        createEventType({ ...base, slug: 'frac-max', maxInvitees: 1.5 }),
      /maxInvitees must be a positive integer/,
    );
  });

  it('keeps rejecting collective and round_robin and leaves one_on_one unchanged', () => {
    for (const kind of ['collective', 'round_robin'] as const) {
      assert.throws(
        () =>
          createEventType({
            hostId: 'host-1',
            slug: `slug-${kind}`,
            name: 'Nope',
            durationMinutes: 30,
            availabilityScheduleId: 'sched-1',
            kind,
          }),
        /rejected/,
      );
    }

    const oneOnOne = createEventType({
      hostId: 'host-1',
      slug: 'intro-30',
      name: 'Intro call',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'one_on_one',
    });
    assert.equal(oneOnOne.kind, 'one_on_one');
    assert.equal(oneOnOne.maxInvitees, undefined);
  });
});

describe('AC-2 group available times include spots_remaining', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('returns spots_remaining and omits a start only when full', async () => {
    const eventType = seedGroup(2);
    const empty = await groupTimes(eventType);
    const open = empty.find((row) => row.start === SLOT_0900);
    assert.ok(open);
    assert.equal(open.spots_remaining, 2);

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    const afterOne = await groupTimes(eventType);
    const remaining = afterOne.find((row) => row.start === SLOT_0900);
    assert.ok(remaining);
    assert.equal(remaining.spots_remaining, 1);

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    const full = await groupTimes(eventType);
    assert.ok(!full.some((row) => row.start === SLOT_0900));
    assert.ok(full.some((row) => row.start === SLOT_0930));
  });

  it('hides group starts that overlap host 1:1 bookings or fixture busy', async () => {
    const group = seedGroup(3, 'workshop');
    const oneOnOne = seedOneOnOne();
    const provider = createFixtureCalendarProvider(FIXTURE);

    await bookAvailableSlot({
      eventType: oneOnOne,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const times = await groupTimes(group);
    assert.ok(!times.some((row) => row.start === SLOT_0900));
    assert.ok(!times.some((row) => row.start === SLOT_1400));
    assert.ok(times.some((row) => row.start === SLOT_0930));
  });

  it('keeps 1:1 listAvailableTimes as string[] and treats a group session as host busy', async () => {
    const group = seedGroup(2, 'workshop');
    const oneOnOne = seedOneOnOne();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const schedule = {
      id: oneOnOne.availabilityScheduleId,
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    };

    await bookAvailableSlot({
      eventType: group,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const times = await listAvailableTimes({
      eventType: oneOnOne,
      schedule,
      timeMin: RANGE_MIN,
      timeMax: RANGE_MAX,
      provider,
      calendarId: 'primary',
      extraBusy: hostBookingsAsBusy(oneOnOne.hostId),
    });

    assert.ok(Array.isArray(times));
    assert.equal(typeof times[0], 'string');
    assert.ok(!times.includes(SLOT_0900));
    assert.ok(times.includes(SLOT_0930));
  });
});

describe('AC-3 group booking create respects capacity', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('confirms invitees while seats remain and returns session_full at capacity', async () => {
    const eventType = seedGroup(1);
    const provider = createFixtureCalendarProvider(FIXTURE);

    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    assert.equal(booking.status, 'confirmed');
    assert.equal(countConfirmedBookingsForSlot(eventType.id, SLOT_0900), 1);

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_0900,
          invitee: { name: 'Grace', email: 'grace@example.com' },
          provider,
          calendarId: 'primary',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BookingConflictError);
        assert.equal(error.status, 409);
        assert.equal(error.message, SESSION_FULL);
        return true;
      },
    );
  });

  it('returns slot_unavailable for busy or out-of-hours starts and leaves 1:1 races unchanged', async () => {
    const group = seedGroup(2);
    const oneOnOne = seedOneOnOne();
    const provider = createFixtureCalendarProvider(FIXTURE);

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType: group,
          start: SLOT_1400,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider,
          calendarId: 'primary',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BookingConflictError);
        assert.equal(error.message, SLOT_UNAVAILABLE);
        return true;
      },
    );

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType: group,
          start: OUTSIDE,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider,
          calendarId: 'primary',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BookingConflictError);
        assert.equal(error.message, SLOT_UNAVAILABLE);
        return true;
      },
    );

    await bookAvailableSlot({
      eventType: oneOnOne,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType: oneOnOne,
          start: SLOT_0900,
          invitee: { name: 'Grace', email: 'grace@example.com' },
          provider,
          calendarId: 'primary',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BookingConflictError);
        assert.equal(error.message, SLOT_UNAVAILABLE);
        return true;
      },
    );
  });
});

describe('AC-4 last-spot race (spec AC-05 spirit)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('lets one overlapping last-seat create succeed and returns session_full for the other', async () => {
    const eventType = seedGroup(2);
    const provider = delayedFixtureProvider(30);

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'First', email: 'first@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    const results = await Promise.allSettled([
      bookAvailableSlot({
        eventType,
        start: SLOT_0900,
        invitee: { name: 'Ada', email: 'ada@example.com' },
        provider,
        calendarId: 'primary',
      }),
      bookAvailableSlot({
        eventType,
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
        provider,
        calendarId: 'primary',
      }),
    ]);

    const fulfilled = results.filter((row) => row.status === 'fulfilled');
    const rejected = results.filter((row) => row.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0] && rejected[0].status === 'rejected');
    assert.ok(rejected[0].reason instanceof BookingConflictError);
    assert.equal(rejected[0].reason.message, SESSION_FULL);
    assert.equal(rejected[0].reason.status, 409);

    const persisted = listConfirmedBookingsForHost('host-1').filter(
      (row) => row.eventTypeId === eventType.id && row.start === SLOT_0900,
    );
    assert.equal(persisted.length, 2);
    assert.ok(persisted.length <= eventType.maxInvitees!);
  });

  it('lets two concurrent creates succeed when two seats remain', async () => {
    const eventType = seedGroup(2);
    const provider = delayedFixtureProvider(30);

    const results = await Promise.allSettled([
      bookAvailableSlot({
        eventType,
        start: SLOT_0900,
        invitee: { name: 'Ada', email: 'ada@example.com' },
        provider,
        calendarId: 'primary',
      }),
      bookAvailableSlot({
        eventType,
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
        provider,
        calendarId: 'primary',
      }),
    ]);

    const fulfilled = results.filter((row) => row.status === 'fulfilled');
    assert.equal(fulfilled.length, 2);
    assert.equal(countConfirmedBookingsForSlot(eventType.id, SLOT_0900), 2);
  });
});
