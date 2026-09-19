import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  GET,
  setAvailableTimesCalendarProvider,
} from '../app/api/event-types/[slug]/available-times/route';
import { createEventType, getEventTypeBySlug, resetEventTypes } from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { bookAvailableSlot, resetBookings } from '../lib/booking/booking';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { isAuthorizedForPath } from '../lib/auth/host-guard';
import { GET as healthGET } from '../app/api/health/route';

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

describe('AC-5 GET /api/event-types/:slug/available-times', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setAvailableTimesCalendarProvider(null);
  });

  it('returns { times } for a seeded one-on-one slug via the fixture provider', async () => {
    seedIntro30();
    const fixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
        'utf8',
      ),
    ) as GoogleFreeBusyFixture;
    setAvailableTimesCalendarProvider(createFixtureCalendarProvider(fixture));

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

  it('omits a start after a confirmed booking on that slot', async () => {
    seedIntro30();
    const fixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
        'utf8',
      ),
    ) as GoogleFreeBusyFixture;
    const provider = createFixtureCalendarProvider(fixture);
    setAvailableTimesCalendarProvider(provider);

    const eventType = getEventTypeBySlug('intro-30');
    assert.ok(eventType);

    await bookAvailableSlot({
      eventType,
      start: '2026-09-20T09:00:00.000Z',
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    const response = await GET(
      new Request(
        'http://localhost/api/event-types/intro-30/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { times: string[] };
    assert.ok(!body.times.includes('2026-09-20T09:00:00.000Z'));
    assert.ok(body.times.includes('2026-09-20T09:30:00.000Z'));
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
