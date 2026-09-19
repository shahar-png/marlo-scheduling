import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  createEventType,
  resetEventTypes,
  type EventType,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { listAvailableTimes } from '../lib/availability/slots';
import {
  bookAvailableSlot,
  BookingConflictError,
  BookingValidationError,
  createBooking,
  getBooking,
  listConfirmedBookingsForHost,
  resetBookings,
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

describe('AC-1 booking stub', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('creates and reads a confirmed 1:1 booking', () => {
    const eventType = seedIntro30();
    const created = createBooking({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      calendarEventId: 'mock-event-1',
    });

    assert.equal(created.status, 'confirmed');
    assert.equal(created.eventTypeId, eventType.id);
    assert.equal(created.hostId, 'host-1');
    assert.equal(created.start, SLOT_0900);
    assert.equal(created.end, SLOT_0930);
    assert.deepEqual(created.invitee, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    assert.equal(created.calendarEventId, 'mock-event-1');
    assert.ok(created.id);

    assert.deepEqual(getBooking(created.id), created);
    assert.equal(listConfirmedBookingsForHost('host-1').length, 1);
  });

  it('rejects empty invitee name or email', () => {
    const eventType = seedIntro30();
    assert.throws(
      () =>
        createBooking({
          eventType,
          start: SLOT_0900,
          invitee: { name: '   ', email: 'ada@example.com' },
          calendarEventId: 'mock-event-1',
        }),
      BookingValidationError,
    );
    assert.throws(
      () =>
        createBooking({
          eventType,
          start: SLOT_0900,
          invitee: { name: 'Ada', email: '   ' },
          calendarEventId: 'mock-event-1',
        }),
      BookingValidationError,
    );
  });

  it('rejects a collective or round_robin event type', () => {
    const eventType = {
      id: 'et-collective',
      hostId: 'host-1',
      slug: 'collective',
      name: 'Collective',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'collective',
    } as unknown as EventType;

    assert.throws(
      () =>
        createBooking({
          eventType,
          start: SLOT_0900,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          calendarEventId: 'mock-event-1',
        }),
      /rejected/,
    );
  });
});

describe('AC-2 CalendarProvider.createEvent mock', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('records createEvent on a successful booking and never calls live Google', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);

    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    assert.equal(booking.status, 'confirmed');
    assert.equal(provider.createdEvents.length, 1);
    assert.equal(provider.createdEvents[0]?.id, booking.calendarEventId);
    assert.equal(provider.createdEvents[0]?.start, SLOT_0900);
    assert.equal(provider.createdEvents[0]?.end, SLOT_0930);
    assert.equal(provider.createdEvents[0]?.summary, 'Intro call');
    assert.deepEqual(provider.createdEvents[0]?.attendees, [
      { email: 'ada@example.com', displayName: 'Ada Lovelace' },
    ]);
    assert.match(booking.calendarEventId, /^mock-event-/);
  });
});

describe('AC-3 booking only against available times', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('confirms a free slot and omits that start from later available times', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const schedule = {
      id: eventType.availabilityScheduleId,
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    };

    const before = await listAvailableTimes({
      eventType,
      schedule,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
    });
    assert.ok(before.includes(SLOT_0900));

    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    assert.equal(booking.status, 'confirmed');

    const after = await listAvailableTimes({
      eventType,
      schedule,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
      extraBusy: listConfirmedBookingsForHost('host-1').map((row) => ({
        start: row.start,
        end: row.end,
      })),
    });
    assert.ok(!after.includes(SLOT_0900));
    assert.ok(after.includes(SLOT_0930));
  });

  it('conflicts when the start is busy, already booked, or outside weekly hours', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_1400,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider,
          calendarId: 'primary',
        }),
      BookingConflictError,
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
      BookingConflictError,
    );

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_0900,
          invitee: { name: 'Grace', email: 'grace@example.com' },
          provider,
          calendarId: 'primary',
        }),
      BookingConflictError,
    );
  });
});

describe('AC-4 double-book race (spec AC-04 spirit)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('lets one concurrent create succeed and returns 409 for the other', async () => {
    const eventType = seedIntro30();
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
    const rejected = results.filter((row) => row.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0] && rejected[0].status === 'rejected');
    assert.ok(rejected[0].reason instanceof BookingConflictError);
    assert.equal((rejected[0].reason as BookingConflictError).status, 409);

    const persisted = listConfirmedBookingsForHost('host-1');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0]?.start, SLOT_0900);
    assert.equal(persisted[0]?.status, 'confirmed');
  });
});
