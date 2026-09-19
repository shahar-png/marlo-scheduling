import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
import { listConfirmedBookingsForHost, resetBookings } from '../lib/booking/booking';
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

function bookingRequest(
  slug: string,
  body: unknown,
): Promise<Response> {
  return POST(
    new Request(`http://localhost/api/event-types/${slug}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

describe('AC-5 POST /api/event-types/:slug/bookings', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
  });

  it('returns 201 and a confirmed booking payload for a free slot', async () => {
    seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    setBookingCalendarProvider(provider);

    const response = await bookingRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      booking: {
        id: string;
        status: string;
        start: string;
        end: string;
        invitee: { name: string; email: string };
      };
    };
    assert.equal(body.booking.status, 'confirmed');
    assert.equal(body.booking.start, SLOT_0900);
    assert.equal(body.booking.end, '2026-09-20T09:30:00.000Z');
    assert.deepEqual(body.booking.invitee, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    assert.ok(body.booking.id);
    assert.equal(provider.createdEvents.length, 1);
  });

  it('returns 409 on conflict, 404 for an unknown slug, and 400 for a missing body', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const conflict = await bookingRequest('intro-30', {
      start: '2026-09-20T14:00:00.000Z',
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(conflict.status, 409);

    const missing = await bookingRequest('nope', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(missing.status, 404);

    const badBody = await bookingRequest('intro-30', {});
    assert.equal(badBody.status, 400);
  });

  it('is public and keeps available-times GET, /, and /api/health public', async () => {
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

    const health = await healthGET();
    assert.equal(health.status, 200);

    seedIntro30();
    const times = await availableTimesGET(
      new Request(
        'http://localhost/api/event-types/intro-30/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(times.status, 200);

    assert.equal(
      existsSync(
        path.join(process.cwd(), 'app/api/event-types/[slug]/bookings/route.ts'),
      ),
      true,
    );
    const routeModule = await import(
      '../app/api/event-types/[slug]/bookings/route'
    );
    assert.equal(typeof routeModule.POST, 'function');
  });

  it('returns 201 and 409 for two concurrent POSTs to the same slot', async () => {
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

    const [first, second] = await Promise.all([
      bookingRequest('intro-30', {
        start: SLOT_0900,
        invitee: { name: 'Ada', email: 'ada@example.com' },
      }),
      bookingRequest('intro-30', {
        start: SLOT_0900,
        invitee: { name: 'Grace', email: 'grace@example.com' },
      }),
    ]);

    const statuses = [first.status, second.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(listConfirmedBookingsForHost('host-1').length, 1);
  });
});
