import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  GET,
  setAvailableTimesCalendarProvider,
} from '../app/api/event-types/[slug]/available-times/route';
import { POST as bookingsPOST } from '../app/api/event-types/[slug]/bookings/route';
import { createEventType } from '../lib/availability/event-type';
import { createAvailabilitySchedule } from '../lib/availability/schedule';
import { resetBookings } from '../lib/booking/booking';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { isAuthorizedForPath } from '../lib/auth/host-guard';
import { GET as healthGET } from '../app/api/health/route';
import { createHarness, teardown, type Harness } from './support/harness';

// Sunday keeps the existing BOOK-core fixture window; Monday is the harness
// clock's own day, which is where the booking case below has to live (a create
// whose start has already elapsed is not on offer — C9).
function seedIntro30() {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [
      { weekday: 0, start: '09:00', end: '20:00' },
      { weekday: 1, start: '09:00', end: '20:00' },
    ],
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

// C2 — the legacy availability read is the counterpart of the legacy create, so
// for a `one_on_one` slug it now runs the **shared** demo-scoped resolution,
// C6.1 occupancy, and C7 `events.list` classification. External busy therefore
// comes from the runtime's calendar, not from the injected fixture `freeBusy`,
// which survives only for the `group`/`collective` fixture path (C6.9).
describe('AC-5 GET /api/event-types/:slug/available-times', () => {
  let harness: Harness;

  beforeEach(() => {
    resetBookings();
    resetCalendarConnections();
    setAvailableTimesCalendarProvider(null);
    harness = createHarness('memory');
  });

  afterEach(() => {
    teardown();
  });

  it('returns { times } for a seeded one-on-one slug, minus external busy', async () => {
    seedIntro30();
    harness.calendar.seedExternal({
      id: 'external-lunch',
      start: '2026-09-20T14:00:00.000Z',
      end: '2026-09-20T15:00:00.000Z',
    });
    harness.calendar.seedExternal({
      id: 'external-evening',
      start: '2026-09-20T18:30:00.000Z',
      end: '2026-09-20T19:00:00.000Z',
    });

    const response = await GET(
      new Request(
        'http://localhost/api/event-types/intro-30/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );

    assert.equal(response.status, 200);
    const body = (await response.json()) as { times: string[] };
    assert.ok(Array.isArray(body.times));
    assert.ok(body.times.includes('2026-09-20T09:00:00.000Z'));
    assert.ok(body.times.includes('2026-09-20T15:00:00.000Z'));
    assert.ok(!body.times.includes('2026-09-20T14:00:00.000Z'));
    assert.ok(!body.times.includes('2026-09-20T18:30:00.000Z'));
  });

  it('returns 404 for an unknown slug and 400 when the range is missing', async () => {
    seedIntro30();

    const missing = await GET(
      new Request(
        'http://localhost/api/event-types/nope/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'nope' }) },
    );
    assert.equal(missing.status, 404);

    const badRange = await GET(
      new Request('http://localhost/api/event-types/intro-30/available-times'),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(badRange.status, 400);
  });

  it('does not export POST on the available-times GET handler', async () => {
    const routePath = path.join(
      process.cwd(),
      'app/api/event-types/[slug]/available-times/route.ts',
    );
    const source = readFileSync(routePath, 'utf8');
    assert.doesNotMatch(source, /export async function POST/);
    assert.doesNotMatch(source, /export function POST/);

    const routeModule = await import(
      '../app/api/event-types/[slug]/available-times/route'
    );
    assert.equal('POST' in routeModule, false);
  });

  it('omits a start the matching legacy POST just booked (shared occupancy)', async () => {
    // The exact pairing the route exists in: whatever the legacy `POST` writes,
    // this `GET` must stop offering. Before the shared occupancy landed, POST
    // wrote the C6 store while GET read the separate legacy map, so the very
    // next availability call still advertised the slot it had just sold.
    seedIntro30();
    const monday = '2026-09-21T10:00:00.000Z';

    const created = await bookingsPOST(
      new Request('http://localhost/api/event-types/intro-30/bookings', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': '5f1c0a3e-1b7e-4a2f-9c8d-0a1b2c3d4e5f',
        },
        body: JSON.stringify({
          start: monday,
          invitee: { name: 'Ada', email: 'ada@example.com' },
        }),
      }),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(created.status, 201);

    const response = await GET(
      new Request(
        'http://localhost/api/event-types/intro-30/available-times?timeMin=2026-09-21T00:00:00.000Z&timeMax=2026-09-22T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { times: string[] };
    assert.ok(!body.times.includes(monday));
    assert.ok(body.times.includes('2026-09-21T10:30:00.000Z'));
  });


  it('keeps GET / and GET /api/health public', async () => {
    assert.equal(isAuthorizedForPath(null, '/'), true);
    assert.equal(isAuthorizedForPath(null, '/api/health'), true);
    assert.equal(
      isAuthorizedForPath(null, '/api/event-types/intro-30/available-times'),
      true,
    );

    const health = await healthGET();
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
  });
});
