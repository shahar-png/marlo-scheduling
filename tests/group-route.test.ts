import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { GET as availableTimesGET } from '../app/api/event-types/[slug]/available-times/route';
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
  countConfirmedBookingsForSlot,
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
const RANGE =
  'timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z';

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

function seedOneOnOne() {
  const schedule = seedSundaySchedule();
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
  return availableTimesGET(
    new Request(
      `http://localhost/api/event-types/${slug}/available-times?${RANGE}`,
    ),
    { params: Promise.resolve({ slug }) },
  );
}

describe('AC-5 group available-times GET and bookings POST', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
  });

  it('returns { times: { start, spots_remaining }[] } for a group slug', async () => {
    seedGroup(3);
    const response = await timesRequest('group-30');
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      times: { start: string; spots_remaining: number }[];
    };
    assert.ok(Array.isArray(body.times));
    const open = body.times.find((row) => row.start === SLOT_0900);
    assert.ok(open);
    assert.equal(open.spots_remaining, 3);
    assert.ok(body.times.some((row) => row.start === SLOT_0930));
    assert.ok(!body.times.some((row) => row.start === '2026-09-20T14:00:00.000Z'));
  });

  it('POSTs 201 while seats remain and 409 session_full when the session is full', async () => {
    const eventType = seedGroup(1);
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const created = await bookingRequest('group-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(created.status, 201);

    const afterOne = await timesRequest('group-30');
    const afterBody = (await afterOne.json()) as {
      times: { start: string; spots_remaining: number }[];
    };
    assert.ok(!afterBody.times.some((row) => row.start === SLOT_0900));

    const full = await bookingRequest('group-30', {
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
    });
    assert.equal(full.status, 409);
    const error = (await full.json()) as { error: string };
    assert.equal(error.error, 'session_full');
    assert.equal(countConfirmedBookingsForSlot(eventType.id, SLOT_0900), 1);
  });

  it('returns 201 and 409 session_full for two concurrent last-spot POSTs', async () => {
    const eventType = seedGroup(2);
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const firstSeat = await bookingRequest('group-30', {
      start: SLOT_0900,
      invitee: { name: 'First', email: 'first@example.com' },
    });
    assert.equal(firstSeat.status, 201);

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

    const [first, second] = await Promise.all([
      bookingRequest('group-30', {
        start: SLOT_0900,
        invitee: { name: 'Ada', email: 'ada@example.com' },
      }),
      bookingRequest('group-30', {
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    const bodies = await Promise.all([first.json(), second.json()]);
    const errors = bodies
      .map((row) => (row as { error?: string }).error)
      .filter((error): error is string => typeof error === 'string');
    assert.deepEqual(errors, ['session_full']);
    assert.equal(countConfirmedBookingsForSlot(eventType.id, SLOT_0900), 2);
  });

  it('keeps 1:1 GET { times: string[] } and public / plus /api/health', async () => {
    seedOneOnOne();
    const times = await timesRequest('intro-30');
    assert.equal(times.status, 200);
    const body = (await times.json()) as { times: string[] };
    assert.ok(Array.isArray(body.times));
    assert.equal(typeof body.times[0], 'string');
    assert.ok(body.times.includes(SLOT_0900));

    assert.equal(isAuthorizedForPath(null, '/'), true);
    assert.equal(isAuthorizedForPath(null, '/api/health'), true);
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/group-30/available-times'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/group-30/bookings'),
      true,
    );

    const health = await healthGET();
    assert.equal(health.status, 200);
  });
});
