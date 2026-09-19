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
  listConfirmedBookingsForHost,
  resetBookings,
} from '../lib/booking/booking';
import {
  connectHostCalendar,
  resetCalendarConnections,
} from '../lib/calendar/connection';
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
const SLOT_1500 = '2026-09-20T15:00:00.000Z';
const OUTSIDE = '2026-09-20T08:00:00.000Z';
const HOST_B_CAL = 'host-2-cal';

function collectiveFixture(hostBBusy: { start: string; end: string }[] = []) {
  return {
    calendars: {
      ...FIXTURE.calendars,
      [HOST_B_CAL]: { busy: hostBBusy },
    },
  } as GoogleFreeBusyFixture;
}

function seedCollective(
  slug = 'panel',
  hostIds: string[] = ['host-1', 'host-2'],
) {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug,
    name: 'Panel interview',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'collective',
    hostIds,
  });
}

function seedIntro30(hostId = 'host-1', slug = 'intro-30') {
  const schedule = createAvailabilitySchedule({
    hostId,
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId,
    slug,
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'one_on_one',
  });
}

function delayedProvider(
  fixture: GoogleFreeBusyFixture,
  delayMs = 25,
): CalendarProvider {
  const inner = createFixtureCalendarProvider(fixture);
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

describe('AC-1 collective event-type stub', () => {
  beforeEach(() => {
    resetEventTypes();
    resetAvailabilitySchedules();
  });

  it('creates and reads a collective event type with multiple hosts', () => {
    const created = createEventType({
      hostId: 'host-1',
      slug: 'panel',
      name: 'Panel interview',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'collective',
      hostIds: ['host-1', 'host-2'],
    });

    assert.equal(created.kind, 'collective');
    assert.deepEqual(created.hostIds, ['host-1', 'host-2']);
    assert.equal(created.slug, 'panel');
    assert.deepEqual(getEventType(created.id), created);
    assert.deepEqual(getEventTypeBySlug('panel'), created);
  });

  it('auto-includes the organizer in hostIds', () => {
    const created = createEventType({
      hostId: 'host-1',
      slug: 'panel',
      name: 'Panel interview',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'collective',
      hostIds: ['host-2'],
    });
    assert.deepEqual(created.hostIds, ['host-1', 'host-2']);
  });

  it('still creates one-on-one and group without hostIds', () => {
    const oneOnOne = createEventType({
      hostId: 'host-1',
      slug: 'intro-30',
      name: 'Intro call',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'one_on_one',
    });
    assert.equal(oneOnOne.kind, 'one_on_one');
    assert.equal(oneOnOne.hostIds, undefined);

    const group = createEventType({
      hostId: 'host-1',
      slug: 'workshop',
      name: 'Workshop',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'group',
      maxInvitees: 4,
    });
    assert.equal(group.kind, 'group');
    assert.equal(group.hostIds, undefined);
  });

  it('rejects missing, empty, single-host, blank, or duplicate-only hostIds', () => {
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'panel-missing',
          name: 'Panel',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'collective',
        }),
      /hostIds must include at least two unique host ids/,
    );
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'panel-empty',
          name: 'Panel',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'collective',
          hostIds: [],
        }),
      /hostIds must include at least two unique host ids/,
    );
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'panel-single',
          name: 'Panel',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'collective',
          hostIds: ['host-1'],
        }),
      /hostIds must include at least two unique host ids/,
    );
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'panel-blank',
          name: 'Panel',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'collective',
          hostIds: ['  ', ''],
        }),
      /hostIds must include at least two unique host ids/,
    );
    assert.throws(
      () =>
        createEventType({
          hostId: 'host-1',
          slug: 'panel-dupes',
          name: 'Panel',
          durationMinutes: 30,
          availabilityScheduleId: 'sched-1',
          kind: 'collective',
          hostIds: ['host-1', 'host-1'],
        }),
      /hostIds must include at least two unique host ids/,
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

describe('AC-2 collective available times are the intersection', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
  });

  it('omits a start when any host calendar is busy and keeps 1:1 string[]', async () => {
    const eventType = seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(
      collectiveFixture([{ start: SLOT_0900, end: SLOT_0930 }]),
    );
    const schedule = {
      id: eventType.availabilityScheduleId,
      hostId: 'host-1',
      timezone: 'UTC' as const,
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    };

    const times = await listAvailableTimes({
      eventType,
      schedule,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
      calendarIds: ['primary', HOST_B_CAL],
    });

    assert.ok(!times.includes(SLOT_0900));
    assert.ok(times.includes(SLOT_0930));
    assert.ok(!times.includes(SLOT_1400));
    assert.ok(times.includes(SLOT_1500));
    assert.ok(times.every((start) => typeof start === 'string'));
  });

  it('omits a start when a co-host has a confirmed booking', async () => {
    const collective = seedCollective();
    const hostB = seedIntro30('host-2', 'intro-b');
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(collectiveFixture());

    await bookAvailableSlot({
      eventType: hostB,
      start: SLOT_0930,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: HOST_B_CAL,
    });

    const times = await listAvailableTimes({
      eventType: collective,
      schedule: {
        id: collective.availabilityScheduleId,
        hostId: 'host-1',
        timezone: 'UTC',
        windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
      },
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
      calendarIds: ['primary', HOST_B_CAL],
      extraBusy: listConfirmedBookingsForHost('host-2').map((row) => ({
        start: row.start,
        end: row.end,
      })),
    });

    assert.ok(times.includes(SLOT_0900));
    assert.ok(!times.includes(SLOT_0930));
  });
});

describe('AC-3 booking assigns all hosts', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
  });

  it('persists hostIds and occupies every assigned host', async () => {
    const eventType = seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(collectiveFixture());
    const hostB = seedIntro30('host-2', 'intro-b');

    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    assert.equal(booking.status, 'confirmed');
    assert.deepEqual(booking.hostIds, ['host-1', 'host-2']);
    assert.deepEqual(getBooking(booking.id)?.hostIds, ['host-1', 'host-2']);
    assert.equal(
      listConfirmedBookingsForHost('host-1').some((row) => row.id === booking.id),
      true,
    );
    assert.equal(
      listConfirmedBookingsForHost('host-2').some((row) => row.id === booking.id),
      true,
    );

    const hostBTimes = await listAvailableTimes({
      eventType: hostB,
      schedule: {
        id: hostB.availabilityScheduleId,
        hostId: 'host-2',
        timezone: 'UTC',
        windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
      },
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: HOST_B_CAL,
      extraBusy: listConfirmedBookingsForHost('host-2').map((row) => ({
        start: row.start,
        end: row.end,
      })),
    });
    assert.ok(!hostBTimes.includes(SLOT_0900));
    assert.ok(hostBTimes.includes(SLOT_0930));
  });

  it('returns slot_unavailable when any host is busy or the start is outside hours', async () => {
    const eventType = seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(
      collectiveFixture([{ start: SLOT_0900, end: SLOT_0930 }]),
    );

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_0900,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider,
          calendarId: 'primary',
        }),
      (error: unknown) => {
        assert.ok(error instanceof BookingConflictError);
        assert.equal(error.status, 409);
        assert.equal(error.message, 'slot_unavailable');
        return true;
      },
    );

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
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
          eventType,
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
  });

  it('persists a confirmed collective booking via the low-level stub', () => {
    const eventType = seedCollective();
    const created = createBooking({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      calendarEventId: 'mock-event-1',
    });
    assert.equal(created.status, 'confirmed');
    assert.deepEqual(created.hostIds, ['host-1', 'host-2']);
    assert.deepEqual(getBooking(created.id), created);
  });
});

describe('AC-4 busy-edge cases (spec AC-06 spirit)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
  });

  it('hides every slot that intersects one host\'s partial-overlap busy window', async () => {
    const eventType = seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(
      collectiveFixture([
        { start: '2026-09-20T09:15:00.000Z', end: '2026-09-20T09:45:00.000Z' },
      ]),
    );

    const times = await listAvailableTimes({
      eventType,
      schedule: {
        id: eventType.availabilityScheduleId,
        hostId: 'host-1',
        timezone: 'UTC',
        windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
      },
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
      calendarIds: ['primary', HOST_B_CAL],
    });

    assert.ok(!times.includes(SLOT_0900));
    assert.ok(!times.includes(SLOT_0930));
    assert.ok(times.includes(SLOT_1500));
  });

  it('hides fixture busy on host A primary even when host B is free', async () => {
    const eventType = seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(collectiveFixture());

    const times = await listAvailableTimes({
      eventType,
      schedule: {
        id: eventType.availabilityScheduleId,
        hostId: 'host-1',
        timezone: 'UTC',
        windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
      },
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
      calendarIds: ['primary', HOST_B_CAL],
    });

    assert.ok(!times.includes(SLOT_1400));
    assert.ok(times.includes(SLOT_0900));
    assert.ok(times.includes(SLOT_0930));
  });

  it('lets one concurrent collective create succeed and slot_unavailable for the other', async () => {
    const eventType = seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = delayedProvider(collectiveFixture(), 30);

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
      'slot_unavailable',
    );

    const persisted = listConfirmedBookingsForHost('host-1').filter(
      (row) => row.start === SLOT_0900,
    );
    assert.equal(persisted.length, 1);
    assert.deepEqual(persisted[0]?.hostIds, ['host-1', 'host-2']);
    assert.equal(
      listConfirmedBookingsForHost('host-2').filter(
        (row) => row.start === SLOT_0900,
      ).length,
      1,
    );
  });
});
