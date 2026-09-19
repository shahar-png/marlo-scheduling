import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  GET,
  setAvailableTimesCalendarProvider,
} from '../app/api/event-types/[slug]/available-times/route';
import {
  POST,
  setBookingCalendarProvider,
} from '../app/api/event-types/[slug]/bookings/route';
import { GET as healthGET } from '../app/api/health/route';
import { isAuthorizedForPath } from '../lib/auth/host-guard';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import {
  bookAvailableSlot,
  listConfirmedBookingsForHost,
  resetBookings,
} from '../lib/booking/booking';
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
const SLOT_1400 = '2026-09-20T14:00:00.000Z';

function seedGroup(maxInvitees = 2) {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug: 'workshop',
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

function bookingRequest(slug: string, body: unknown): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/event-types/${slug}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

function timesRequest(slug: string): Promise<Response> {
  return GET(
    new Request(
      `http://localhost/api/event-types/${slug}/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z`,
    ),
    { params: Promise.resolve({ slug }) },
  );
}

describe('AC-5 group available-times GET + bookings POST', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setAvailableTimesCalendarProvider(null);
    setBookingCalendarProvider(null);
  });

  it('returns { times: { start, spots_remaining }[] } for a group slug', async () => {
    const eventType = seedGroup(3);
    const provider = createFixtureCalendarProvider(FIXTURE);
    setAvailableTimesCalendarProvider(provider);
    setBookingCalendarProvider(provider);

    const empty = await timesRequest('workshop');
    assert.equal(empty.status, 200);
    const emptyBody = (await empty.json()) as {
      times: { start: string; spots_remaining: number }[];
    };
    const nine = emptyBody.times.find((row) => row.start === SLOT_0900);
    assert.ok(nine);
    assert.equal(nine.spots_remaining, 3);
    assert.ok(emptyBody.times.every((row) => typeof row.start === 'string'));
    assert.ok(
      emptyBody.times.every((row) => typeof row.spots_remaining === 'number'),
    );
    assert.ok(!emptyBody.times.some((row) => row.start === SLOT_1400));

    await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const after = await timesRequest('workshop');
    const afterBody = (await after.json()) as {
      times: { start: string; spots_remaining: number }[];
    };
    assert.equal(
      afterBody.times.find((row) => row.start === SLOT_0900)?.spots_remaining,
      2,
    );
    assert.ok(afterBody.times.some((row) => row.start === SLOT_0930));
  });

  it('keeps 1:1 GET as { times: string[] }', async () => {
    seedIntro30();
    setAvailableTimesCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const response = await timesRequest('intro-30');
    assert.equal(response.status, 200);
    const body = (await response.json()) as { times: string[] };
    assert.ok(typeof body.times[0] === 'string');
    assert.ok(body.times.includes(SLOT_0900));
  });

  it('POSTs 201 while seats remain and 409 session_full when full', async () => {
    seedGroup(2);
    const provider = createFixtureCalendarProvider(FIXTURE);
    setBookingCalendarProvider(provider);

    const first = await bookingRequest('workshop', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as { booking: { status: string } };
    assert.equal(firstBody.booking.status, 'confirmed');

    const second = await bookingRequest('workshop', {
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
    });
    assert.equal(second.status, 201);

    const full = await bookingRequest('workshop', {
      start: SLOT_0900,
      invitee: { name: 'Alan', email: 'alan@example.com' },
    });
    assert.equal(full.status, 409);
    const fullBody = (await full.json()) as { error: string };
    assert.equal(fullBody.error, 'session_full');
    assert.equal(listConfirmedBookingsForHost('host-1').length, 2);
  });

  it('returns 201 and 409 session_full for two concurrent last-spot POSTs', async () => {
    seedGroup(2);
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

    const seed = await bookingRequest('workshop', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(seed.status, 201);

    const [first, second] = await Promise.all([
      bookingRequest('workshop', {
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
      }),
      bookingRequest('workshop', {
        start: SLOT_0900,
        invitee: { name: 'Alan', email: 'alan@example.com' },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const bodies = await Promise.all([first.json(), second.json()]);
    const errors = bodies
      .map((body) => (body as { error?: string }).error)
      .filter(Boolean);
    assert.deepEqual(errors, ['session_full']);
    assert.equal(
      listConfirmedBookingsForHost('host-1').filter(
        (row) => row.start === SLOT_0900,
      ).length,
      2,
    );
  });

  it('is public and keeps /, /api/health, and 1:1 available-times public', async () => {
    assert.equal(isAuthorizedForPath(null, '/'), true);
    assert.equal(isAuthorizedForPath(null, '/api/health'), true);
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/workshop/available-times'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/workshop/bookings'),
      true,
    );

    const health = await healthGET();
    assert.equal(health.status, 200);
  });
});
