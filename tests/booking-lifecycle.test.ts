import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  createEventType,
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
  BookingNotFoundError,
  BookingValidationError,
  cancelBooking,
  getBooking,
  listConfirmedBookingsForHost,
  rescheduleBooking,
  resetBookings,
} from '../lib/booking/booking';
import {
  listCancelledReminderJobs,
  resetReminderJobs,
} from '../lib/booking/reminders';
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
const SLOT_1000 = '2026-09-20T10:00:00.000Z';
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

function delayedFixtureProvider(delayMs = 25): CalendarProvider & {
  patchedEvents: ReturnType<typeof createFixtureCalendarProvider>['patchedEvents'];
  deletedEventIds: string[];
} {
  const inner = createFixtureCalendarProvider(FIXTURE);
  return {
    patchedEvents: inner.patchedEvents,
    deletedEventIds: inner.deletedEventIds,
    async freeBusy(query) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return inner.freeBusy(query);
    },
    createEvent: (event) => inner.createEvent(event),
    updateEvent: (event) => inner.updateEvent(event),
    deleteEvent: (event) => inner.deleteEvent(event),
  };
}

async function availableStarts(eventType: ReturnType<typeof seedIntro30>) {
  return listAvailableTimes({
    eventType,
    schedule: {
      id: eventType.availabilityScheduleId,
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    },
    timeMin: '2026-09-20T00:00:00.000Z',
    timeMax: '2026-09-21T00:00:00.000Z',
    provider: createFixtureCalendarProvider(FIXTURE),
    calendarId: 'primary',
    extraBusy: listConfirmedBookingsForHost('host-1').map((row) => ({
      start: row.start,
      end: row.end,
    })),
  });
}

describe('AC-1 invitee reschedule to a new available slot', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetReminderJobs();
  });

  it('moves a confirmed booking and frees the old start', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const moved = await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider,
      calendarId: 'primary',
    });

    assert.equal(moved.status, 'confirmed');
    assert.equal(moved.id, created.id);
    assert.equal(moved.start, SLOT_0930);
    assert.equal(moved.end, SLOT_1000);
    assert.deepEqual(getBooking(created.id), moved);

    const times = await availableStarts(eventType);
    assert.ok(times.includes(SLOT_0900));
    assert.ok(!times.includes(SLOT_0930));
  });

  it('rejects an empty or invalid start, unknown booking, and cancelled booking', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    await assert.rejects(
      () =>
        rescheduleBooking({
          bookingId: created.id,
          start: 'not-an-instant',
          provider,
          calendarId: 'primary',
        }),
      BookingValidationError,
    );
    await assert.rejects(
      () =>
        rescheduleBooking({
          bookingId: 'missing-booking',
          start: SLOT_0930,
          provider,
          calendarId: 'primary',
        }),
      BookingNotFoundError,
    );

    await cancelBooking({
      bookingId: created.id,
      reason: 'cannot make it',
      provider,
      calendarId: 'primary',
    });
    await assert.rejects(
      () =>
        rescheduleBooking({
          bookingId: created.id,
          start: SLOT_0930,
          provider,
          calendarId: 'primary',
        }),
      /only confirmed/,
    );
  });
});

describe('AC-2 CalendarProvider updateEvent + deleteEvent mocks', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetReminderJobs();
  });

  it('patches the calendar event on reschedule and deletes it on cancel', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider,
      calendarId: 'primary',
    });

    assert.equal(provider.patchedEvents.length, 1);
    assert.equal(provider.patchedEvents[0]?.id, created.calendarEventId);
    assert.equal(provider.patchedEvents[0]?.eventId, created.calendarEventId);
    assert.equal(provider.patchedEvents[0]?.start, SLOT_0930);
    assert.equal(provider.patchedEvents[0]?.end, SLOT_1000);
    assert.equal(provider.deletedEventIds.length, 0);

    await cancelBooking({
      bookingId: created.id,
      reason: 'conflict',
      provider,
      calendarId: 'primary',
    });
    assert.deepEqual(provider.deletedEventIds, [created.calendarEventId]);
  });
});

describe('AC-3 reschedule conflict + reminder job stub', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetReminderJobs();
  });

  it('conflicts when the new start is busy, taken, or outside weekly hours', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const first = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    await bookAvailableSlot({
      eventType,
      start: SLOT_1000,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider,
      calendarId: 'primary',
    });

    await assert.rejects(
      () =>
        rescheduleBooking({
          bookingId: first.id,
          start: SLOT_1400,
          provider,
          calendarId: 'primary',
        }),
      BookingConflictError,
    );
    await assert.rejects(
      () =>
        rescheduleBooking({
          bookingId: first.id,
          start: OUTSIDE,
          provider,
          calendarId: 'primary',
        }),
      BookingConflictError,
    );
    await assert.rejects(
      () =>
        rescheduleBooking({
          bookingId: first.id,
          start: SLOT_1000,
          provider,
          calendarId: 'primary',
        }),
      BookingConflictError,
    );
    assert.equal(getBooking(first.id)?.start, SLOT_0900);
  });

  it('cancels old reminder jobs on reschedule and cancel', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider,
      calendarId: 'primary',
    });
    assert.deepEqual(listCancelledReminderJobs(), [created.id]);

    await cancelBooking({
      bookingId: created.id,
      reason: 'feeling unwell',
      provider,
      calendarId: 'primary',
    });
    assert.deepEqual(listCancelledReminderJobs(), [created.id, created.id]);
  });
});

describe('AC-4 reschedule race/conflict', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetReminderJobs();
  });

  it('lets one concurrent reschedule claim the slot and returns 409 for the other', async () => {
    const eventType = seedIntro30();
    const provider = delayedFixtureProvider(30);
    const first = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    const second = await bookAvailableSlot({
      eventType,
      start: SLOT_1000,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider,
      calendarId: 'primary',
    });

    const results = await Promise.allSettled([
      rescheduleBooking({
        bookingId: first.id,
        start: SLOT_0930,
        provider,
        calendarId: 'primary',
      }),
      rescheduleBooking({
        bookingId: second.id,
        start: SLOT_0930,
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

    const occupants = listConfirmedBookingsForHost('host-1').filter(
      (row) => row.start === SLOT_0930,
    );
    assert.equal(occupants.length, 1);
    assert.equal(listConfirmedBookingsForHost('host-1').length, 2);
  });

  it('serializes a reschedule against a concurrent create for the same slot', async () => {
    const eventType = seedIntro30();
    const provider = delayedFixtureProvider(30);
    const existing = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const results = await Promise.allSettled([
      rescheduleBooking({
        bookingId: existing.id,
        start: SLOT_0930,
        provider,
        calendarId: 'primary',
      }),
      bookAvailableSlot({
        eventType,
        start: SLOT_0930,
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

    const occupants = listConfirmedBookingsForHost('host-1').filter(
      (row) => row.start === SLOT_0930,
    );
    assert.equal(occupants.length, 1);
  });
});
