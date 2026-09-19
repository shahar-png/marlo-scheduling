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
  listConfirmedBookingsForHost,
  resetBookings,
} from '../lib/booking/booking';
import {
  connectHostCalendar,
  resetCalendarConnections,
} from '../lib/calendar/connection';
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
const HOST_B_CAL = 'host-2-cal';

function collectiveFixture(hostBBusy: { start: string; end: string }[] = []) {
  return {
    calendars: {
      ...FIXTURE.calendars,
      [HOST_B_CAL]: { busy: hostBBusy },
    },
  } as GoogleFreeBusyFixture;
}

function seedCollective() {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug: 'panel',
    name: 'Panel interview',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'collective',
    hostIds: ['host-1', 'host-2'],
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

describe('AC-5 collective available-times GET + bookings POST', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setAvailableTimesCalendarProvider(null);
    setBookingCalendarProvider(null);
  });

  it('returns { times: string[] } intersection starts for a collective slug', async () => {
    seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(
      collectiveFixture([{ start: SLOT_0900, end: SLOT_0930 }]),
    );
    setAvailableTimesCalendarProvider(provider);

    const response = await timesRequest('panel');
    assert.equal(response.status, 200);
    const body = (await response.json()) as { times: string[] };
    assert.ok(Array.isArray(body.times));
    assert.ok(typeof body.times[0] === 'string');
    assert.ok(!body.times.includes(SLOT_0900));
    assert.ok(body.times.includes(SLOT_0930));
    assert.ok(!body.times.includes(SLOT_1400));
    assert.ok(!body.times.some((row) => typeof row === 'object'));
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

  it('POSTs 201 with hostIds when all hosts are free and 409 when any host is busy', async () => {
    seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const provider = createFixtureCalendarProvider(
      collectiveFixture([{ start: SLOT_0900, end: SLOT_0930 }]),
    );
    setBookingCalendarProvider(provider);
    setAvailableTimesCalendarProvider(provider);

    const busy = await bookingRequest('panel', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(busy.status, 409);
    const busyBody = (await busy.json()) as { error: string };
    assert.equal(busyBody.error, 'slot_unavailable');

    const created = await bookingRequest('panel', {
      start: SLOT_0930,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      booking: { status: string; hostIds?: string[] };
    };
    assert.equal(createdBody.booking.status, 'confirmed');
    assert.deepEqual(createdBody.booking.hostIds, ['host-1', 'host-2']);
    assert.equal(listConfirmedBookingsForHost('host-2').length, 1);

    const taken = await bookingRequest('panel', {
      start: SLOT_0930,
      invitee: { name: 'Grace', email: 'grace@example.com' },
    });
    assert.equal(taken.status, 409);
    const takenBody = (await taken.json()) as { error: string };
    assert.equal(takenBody.error, 'slot_unavailable');
  });

  it('returns 201 and 409 slot_unavailable for two concurrent collective POSTs', async () => {
    seedCollective();
    connectHostCalendar('host-2', HOST_B_CAL);
    const inner = createFixtureCalendarProvider(collectiveFixture());
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
      bookingRequest('panel', {
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
      }),
      bookingRequest('panel', {
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
    assert.deepEqual(errors, ['slot_unavailable']);
    const winner = bodies.find((body) => (body as { booking?: { hostIds?: string[] } }).booking);
    assert.deepEqual(
      (winner as { booking: { hostIds: string[] } }).booking.hostIds,
      ['host-1', 'host-2'],
    );
    assert.equal(
      listConfirmedBookingsForHost('host-1').filter(
        (row) => row.start === SLOT_0900,
      ).length,
      1,
    );
  });

  it('is public and keeps /, /api/health, and 1:1 available-times public', async () => {
    assert.equal(isAuthorizedForPath(null, '/'), true);
    assert.equal(isAuthorizedForPath(null, '/api/health'), true);
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/panel/available-times'),
      true,
    );
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/panel/bookings'),
      true,
    );

    const health = await healthGET();
    assert.equal(health.status, 200);
  });
});
