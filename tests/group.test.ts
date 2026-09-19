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
import { listAvailableTimes } from '../lib/availability/slots';
import {
  bookAvailableSlot,
  BookingConflictError,
  createBooking,
  getBooking,
  hostBookingsAsBusy,
  listConfirmedBookingsForHost,
  resetBookings,
  withSpotsRemaining,
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

function seedGroup(maxInvitees = 3, slug = 'workshop') {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug,
    name: 'Workshop',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'group',
    maxInvitees,
  });
}

function seedIntro30() {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug: 'intro-30',
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

describe('AC-1 group event-type stub', () => {
  beforeEach(() => {
    resetEventTypes();
    resetAvailabilitySchedules();
  });

  it('creates and reads a group event type with maxInvitees', () => {
    const created = createEventType({
      hostId: 'host-1',
      slug: 'workshop',
      name: 'Workshop',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'group',
      maxInvitees: 5,
    });

    assert.equal(created.kind, 'group');
    assert.equal(created.maxInvitees, 5);
    assert.equal(created.slug, 'workshop');
    assert.deepEqual(getEventType(created.id), created);
    assert.deepEqual(getEventTypeBySlug('workshop'), created);
  });

  it('still creates a one-on-one event type without maxInvitees', () => {
    const created = createEventType({
      hostId: 'host-1',
      slug: 'intro-30',
      name: 'Intro call',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'one_on_one',
    });
    assert.equal(created.kind, 'one_on_one');
    assert.equal(created.maxInvitees, undefined);
  });

  it('rejects missing, zero, or non-integer maxInvitees on group', () => {
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'workshop',
          name: 'Workshop',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'group',
        }),
      /maxInvitees must be a positive integer/,
    );
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'workshop-zero',
          name: 'Workshop',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'group',
          maxInvitees: 0,
        }),
      /maxInvitees must be a positive integer/,
    );
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'workshop-frac',
          name: 'Workshop',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'group',
          maxInvitees: 2.5,
        }),
      /maxInvitees must be a positive integer/,
    );
  });

  it('rejects round_robin kinds', () => {
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'slug-round_robin',
          name: 'Nope',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'round_robin',
        }),
      /rejected/,
    );
  });
});

describe('AC-2 group available times show spots_remaining', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('returns spots_remaining = maxInvitees minus confirmed seats and omits a full start', async () => {
    const eventType = seedGroup(2);
    const provider = createFixtureCalendarProvider(FIXTURE);
    const schedule = {
      id: eventType.availabilityScheduleId,
      hostId: 'host-1',
      timezone: 'UTC' as const,
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    };

    const extraBusy = hostBookingsAsBusy(eventType.hostId, {
      excludeEventTypeId: eventType.id,
    });
    const before = withSpotsRemaining(
      await listAvailableTimes({
        eventType,
        schedule,
        timeMin: '2026-09-20T00:00:00.000Z',
        timeMax: '2026-09-21T00:00:00.000Z',
        provider,
        calendarId: 'primary',
        extraBusy,
      }),
      eventType,
    );

    const nine = before.find((row) => row.start === SLOT_0900);
    assert.ok(nine);
    assert.equal(nine.spots_remaining, 2);
    assert.ok(!before.some((row) => row.start === SLOT_1400));

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const afterOne = withSpotsRemaining(
      await listAvailableTimes({
        eventType,
        schedule,
        timeMin: '2026-09-20T00:00:00.000Z',
        timeMax: '2026-09-21T00:00:00.000Z',
        provider,
        calendarId: 'primary',
        extraBusy: hostBookingsAsBusy(eventType.hostId, {
          excludeEventTypeId: eventType.id,
        }),
      }),
      eventType,
    );
    const nineAfter = afterOne.find((row) => row.start === SLOT_0900);
    assert.ok(nineAfter);
    assert.equal(nineAfter.spots_remaining, 1);
    assert.ok(afterOne.some((row) => row.start === SLOT_0930));

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider,
      calendarId: 'primary',
    });

    const afterFull = withSpotsRemaining(
      await listAvailableTimes({
        eventType,
        schedule,
        timeMin: '2026-09-20T00:00:00.000Z',
        timeMax: '2026-09-21T00:00:00.000Z',
        provider,
        calendarId: 'primary',
        extraBusy: hostBookingsAsBusy(eventType.hostId, {
          excludeEventTypeId: eventType.id,
        }),
      }),
      eventType,
    );
    assert.ok(!afterFull.some((row) => row.start === SLOT_0900));
    assert.ok(afterFull.some((row) => row.start === SLOT_0930));
  });

  it('hides a group start that overlaps a 1:1 booking or fixture busy', async () => {
    const group = seedGroup(3);
    const oneOnOne = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);

    await bookAvailableSlot({
      eventType: oneOnOne,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const times = withSpotsRemaining(
      await listAvailableTimes({
        eventType: group,
        schedule: {
          id: group.availabilityScheduleId,
          hostId: 'host-1',
          timezone: 'UTC',
          windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
        },
        timeMin: '2026-09-20T00:00:00.000Z',
        timeMax: '2026-09-21T00:00:00.000Z',
        provider,
        calendarId: 'primary',
        extraBusy: hostBookingsAsBusy(group.hostId, {
          excludeEventTypeId: group.id,
        }),
      }),
      group,
    );

    assert.ok(!times.some((row) => row.start === SLOT_0900));
    assert.ok(times.some((row) => row.start === SLOT_0930));
    assert.ok(!times.some((row) => row.start === SLOT_1400));
  });

  it('keeps 1:1 listAvailableTimes as string[] and omits a taken 1:1 start', async () => {
    const oneOnOne = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const schedule = {
      id: oneOnOne.availabilityScheduleId,
      hostId: 'host-1',
      timezone: 'UTC' as const,
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    };

    const before = await listAvailableTimes({
      eventType: oneOnOne,
      schedule,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
    });
    assert.ok(typeof before[0] === 'string');
    assert.ok(before.includes(SLOT_0900));

    await bookAvailableSlot({
      eventType: oneOnOne,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const after = await listAvailableTimes({
      eventType: oneOnOne,
      schedule,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
      extraBusy: hostBookingsAsBusy('host-1'),
    });
    assert.ok(!after.includes(SLOT_0900));
  });
});

describe('AC-3 group booking create respects capacity', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('confirms invitees while seats remain and then returns session_full', async () => {
    const eventType = seedGroup(2);
    const provider = createFixtureCalendarProvider(FIXTURE);

    const first = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    const second = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider,
      calendarId: 'primary',
    });

    assert.equal(first.status, 'confirmed');
    assert.equal(second.status, 'confirmed');
    assert.equal(listConfirmedBookingsForHost('host-1').length, 2);
    assert.deepEqual(getBooking(first.id)?.invitee, {
      name: 'Ada',
      email: 'ada@example.com',
    });

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_0900,
          invitee: { name: 'Alan', email: 'alan@example.com' },
          provider,
          calendarId: 'primary',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BookingConflictError);
        assert.equal(error.status, 409);
        assert.equal(error.message, 'session_full');
        return true;
      },
    );
  });

  it('uses slot_unavailable for busy, outside-hours, and unchanged 1:1 conflicts', async () => {
    const group = seedGroup(3);
    const oneOnOne = seedIntro30();
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
        assert.equal(error.message, 'slot_unavailable');
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
        assert.equal(error.message, 'slot_unavailable');
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
        assert.equal(error.message, 'slot_unavailable');
        return true;
      },
    );
  });

  it('persists a confirmed group booking via the low-level stub', () => {
    const eventType = seedGroup(3);
    const created = createBooking({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      calendarEventId: 'mock-event-1',
    });
    assert.equal(created.status, 'confirmed');
    assert.equal(created.eventTypeId, eventType.id);
    assert.deepEqual(getBooking(created.id), created);
  });
});

describe('AC-4 last-spot race (spec AC-05 spirit)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('lets one concurrent last-seat create succeed and returns session_full for the other', async () => {
    const eventType = seedGroup(2);
    const provider = delayedFixtureProvider(30);

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const results = await Promise.allSettled([
      bookAvailableSlot({
        eventType,
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
        provider,
        calendarId: 'primary',
      }),
      bookAvailableSlot({
        eventType,
        start: SLOT_0900,
        invitee: { name: 'Alan', email: 'alan@example.com' },
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
    assert.equal((rejected[0].reason as BookingConflictError).status, 409);
    assert.equal(
      (rejected[0].reason as BookingConflictError).message,
      'session_full',
    );

    const persisted = listConfirmedBookingsForHost('host-1').filter(
      (row) => row.start === SLOT_0900,
    );
    assert.equal(persisted.length, 2);
    assert.ok(persisted.every((row) => row.status === 'confirmed'));
  });

  it('lets two concurrent creates both succeed when two seats remain', async () => {
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
    assert.equal(
      listConfirmedBookingsForHost('host-1').filter(
        (row) => row.start === SLOT_0900,
      ).length,
      2,
    );
  });
});
