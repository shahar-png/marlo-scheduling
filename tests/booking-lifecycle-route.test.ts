import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { GET as availableTimesGET } from '../app/api/event-types/[slug]/available-times/route';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { POST as cancelPOST } from '../app/api/bookings/[id]/cancel/route';
import { POST as reschedulePOST } from '../app/api/bookings/[id]/reschedule/route';
import { GET as healthGET } from '../app/api/health/route';
import { isAuthorizedForPath } from '../lib/auth/host-guard';
import {
  createEventType,
  getEventTypeBySlug,
  resetEventTypes,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import {
  bookAvailableSlot,
  getBooking,
  listConfirmedBookingsForHost,
  resetBookings,
} from '../lib/booking/booking';
import { getBookingCalendarProvider } from '../lib/booking/calendar-runtime';
import { resetReminderJobs } from '../lib/booking/reminders';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
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

// The subject here is the retained legacy reschedule/cancel handlers, which
// operate on a legacy row. Creating that row through the library keeps the
// subject intact now that the legacy HTTP create sends `one_on_one` through the
// shared C6 lifecycle instead (C2).
async function createRequest(
  slug: string,
  body: { start: string; invitee: { name: string; email: string } },
): Promise<Response> {
  const eventType = getEventTypeBySlug(slug);
  if (!eventType) {
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }
  try {
    const booking = await bookAvailableSlot({
      eventType,
      start: body.start,
      invitee: body.invitee,
      provider: getBookingCalendarProvider(),
      calendarId: 'primary',
    });
    return Response.json({ booking }, { status: 201 });
  } catch {
    return Response.json({ error: 'conflict' }, { status: 409 });
  }
}

function rescheduleRequest(id: string, body: unknown): Promise<Response> {
  return reschedulePOST(
    new Request(`http://localhost/api/bookings/${id}/reschedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function cancelRequest(id: string, body: unknown): Promise<Response> {
  return cancelPOST(
    new Request(`http://localhost/api/bookings/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('AC-5 invitee cancel + public lifecycle routes', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetReminderJobs();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
  });

  it('cancels a confirmed booking with a reason and frees the slot', async () => {
    seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    setBookingCalendarProvider(provider);

    const created = await createRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { booking: { id: string } };

    const cancelled = await cancelRequest(createdBody.booking.id, {
      reason: 'need to postpone',
    });
    assert.equal(cancelled.status, 200);
    const body = (await cancelled.json()) as {
      booking: {
        id: string;
        status: string;
        start: string;
        cancelReason?: string;
      };
    };
    assert.equal(body.booking.status, 'cancelled');
    assert.equal(body.booking.cancelReason, 'need to postpone');
    assert.equal(body.booking.start, SLOT_0900);
    assert.equal(getBooking(createdBody.booking.id)?.status, 'cancelled');
    assert.equal(listConfirmedBookingsForHost('host-1').length, 0);
    assert.deepEqual(provider.deletedEventIds, [getBooking(createdBody.booking.id)?.calendarEventId]);

    const times = await availableTimesGET(
      new Request(
        'http://localhost/api/event-types/intro-30/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(times.status, 200);
    const timesBody = (await times.json()) as { times: string[] };
    assert.ok(timesBody.times.includes(SLOT_0900));
  });

  it('returns 400 without a reason, 404 for unknown booking, and 200 after reschedule', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const created = await createRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    const createdBody = (await created.json()) as { booking: { id: string } };

    const missingReason = await cancelRequest(createdBody.booking.id, {});
    assert.equal(missingReason.status, 400);

    const emptyReason = await cancelRequest(createdBody.booking.id, {
      reason: '   ',
    });
    assert.equal(emptyReason.status, 400);

    // C11 — an id that resolves to nothing is authenticated exactly like one
    // that does, so an unauthenticated call is 401 `token_required` whether or
    // not a booking exists under it. Answering 404 here (and 401 for a real
    // durable id) was a booking-existence oracle (REV-08).
    const missing = await cancelRequest('nope', { reason: 'changed plans' });
    assert.equal(missing.status, 401);
    assert.equal(((await missing.json()) as { error: string }).error, 'token_required');

    const unknownReschedule = await rescheduleRequest('nope', {
      start: SLOT_0930,
    });
    assert.equal(unknownReschedule.status, 401);

    const moved = await rescheduleRequest(createdBody.booking.id, {
      start: SLOT_0930,
    });
    assert.equal(moved.status, 200);
    const movedBody = (await moved.json()) as {
      booking: { status: string; start: string; end: string };
    };
    assert.equal(movedBody.booking.status, 'confirmed');
    assert.equal(movedBody.booking.start, SLOT_0930);
    assert.equal(movedBody.booking.end, SLOT_1000);
  });

  it('keeps lifecycle routes public along with booking POST, available-times, /, and /api/health', async () => {
    assert.equal(isAuthorizedForPath(null, '/'), true);
    assert.equal(isAuthorizedForPath(null, '/api/health'), true);
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/intro-30/available-times'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/intro-30/bookings'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/bookings/booking-1/reschedule'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/bookings/booking-1/cancel'),
      true,
    );

    const health = await healthGET();
    assert.equal(health.status, 200);

    assert.equal(
      existsSync(
        path.join(process.cwd(), 'app/api/bookings/[id]/reschedule/route.ts'),
      ),
      true,
    );
    assert.equal(
      existsSync(
        path.join(process.cwd(), 'app/api/bookings/[id]/cancel/route.ts'),
      ),
      true,
    );
    const rescheduleModule = await import(
      '../app/api/bookings/[id]/reschedule/route'
    );
    const cancelModule = await import('../app/api/bookings/[id]/cancel/route');
    assert.equal(typeof rescheduleModule.POST, 'function');
    assert.equal(typeof cancelModule.POST, 'function');
  });

  it('returns 200 and 409 for two concurrent reschedules onto the same slot', async () => {
    seedIntro30();
    const inner = createFixtureCalendarProvider(FIXTURE);
    setBookingCalendarProvider({
      async freeBusy(query) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return inner.freeBusy(query);
      },
      createEvent: (event) => inner.createEvent(event),
      updateEvent: (event) => inner.updateEvent(event),
      deleteEvent: (event) => inner.deleteEvent(event),
    });

    const first = await createRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    const second = await createRequest('intro-30', {
      start: SLOT_1000,
      invitee: { name: 'Grace', email: 'grace@example.com' },
    });
    const firstBody = (await first.json()) as { booking: { id: string } };
    const secondBody = (await second.json()) as { booking: { id: string } };

    const [a, b] = await Promise.all([
      rescheduleRequest(firstBody.booking.id, { start: SLOT_0930 }),
      rescheduleRequest(secondBody.booking.id, { start: SLOT_0930 }),
    ]);

    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const occupants = listConfirmedBookingsForHost('host-1').filter(
      (row) => row.start === SLOT_0930,
    );
    assert.equal(occupants.length, 1);
  });
});
