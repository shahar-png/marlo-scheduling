import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { GET as healthGET } from '../app/api/health/route';
import { GET as linkTimesGET } from '../app/api/links/[token]/available-times/route';
import {
  POST as linkBookPOST,
  setBookingCalendarProvider,
} from '../app/api/links/[token]/bookings/route';
import { GET as availableTimesGET } from '../app/api/event-types/[slug]/available-times/route';
import { isAuthorizedForPath } from '../lib/auth/host-guard';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createOneOffMeeting,
  resetOneOffMeetings,
} from '../lib/availability/one-off';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import {
  createSingleUseLink,
  getSingleUseLinkByToken,
  LINK_CONSUMED,
  resetSingleUseLinks,
} from '../lib/availability/single-use-link';
import { resetBookings } from '../lib/booking/booking';
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

function seedOffsiteLink(token = 'guest-once') {
  const meeting = createOneOffMeeting({
    hostId: 'host-1',
    name: 'Offsite',
    durationMinutes: 30,
    timezone: 'UTC',
    windows: [{ date: '2026-09-20', start: '09:00', end: '20:00' }],
  });
  return createSingleUseLink({
    oneOffMeetingId: meeting.id,
    token,
  });
}

function seedEventTypeLink(token = 'weekly-once') {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  const eventType = createEventType({
    hostId: 'host-1',
    slug: 'intro-30',
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'one_on_one',
  });
  return createSingleUseLink({
    eventTypeId: eventType.id,
    token,
  });
}

function bookRequest(token: string, body: unknown): Promise<Response> {
  return linkBookPOST(
    new Request(`http://localhost/api/links/${token}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ token }) },
  );
}

function timesRequest(token: string): Promise<Response> {
  return linkTimesGET(
    new Request(
      `http://localhost/api/links/${token}/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z`,
    ),
    { params: Promise.resolve({ token }) },
  );
}

describe('AC-5 POST /api/links/:token/bookings consume + 410 reuse', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetOneOffMeetings();
    resetSingleUseLinks();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
  });

  it('returns 201 then 410 on reuse, and GET times is 410 after consume', async () => {
    seedOffsiteLink('once');
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const openTimes = await timesRequest('once');
    assert.equal(openTimes.status, 200);
    const openBody = (await openTimes.json()) as { times: string[] };
    assert.ok(openBody.times.includes(SLOT_0900));

    const created = await bookRequest('once', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as {
      booking: { id: string; status: string; start: string };
    };
    assert.equal(createdBody.booking.status, 'confirmed');
    assert.equal(createdBody.booking.start, SLOT_0900);
    assert.equal(getSingleUseLinkByToken('once')?.status, LINK_CONSUMED);

    const reuse = await bookRequest('once', {
      start: '2026-09-20T09:30:00.000Z',
      invitee: { name: 'Grace', email: 'grace@example.com' },
    });
    assert.equal(reuse.status, 410);

    const consumedTimes = await timesRequest('once');
    assert.equal(consumedTimes.status, 410);
  });

  it('returns 404 for an unknown token and 400 for a missing body', async () => {
    seedEventTypeLink('valid');
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const missing = await bookRequest('nope', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(missing.status, 404);

    const missingTimes = await timesRequest('nope');
    assert.equal(missingTimes.status, 404);

    const badBody = await bookRequest('valid', {});
    assert.equal(badBody.status, 400);

    const missingRange = await linkTimesGET(
      new Request('http://localhost/api/links/valid/available-times'),
      { params: Promise.resolve({ token: 'valid' }) },
    );
    assert.equal(missingRange.status, 400);
  });

  it('is public and keeps existing public routes public', async () => {
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
      isAuthorizedForPath(null, '/api/links/once/available-times'),
      true,
    );
    assert.equal(isAuthorizedForPath(null, '/api/links/once/bookings'), true);

    const health = await healthGET();
    assert.equal(health.status, 200);

    seedEventTypeLink();
    const times = await availableTimesGET(
      new Request(
        'http://localhost/api/event-types/intro-30/available-times?timeMin=2026-09-20T00:00:00.000Z&timeMax=2026-09-21T00:00:00.000Z',
      ),
      { params: Promise.resolve({ slug: 'intro-30' }) },
    );
    assert.equal(times.status, 200);

    assert.equal(
      existsSync(
        path.join(process.cwd(), 'app/api/links/[token]/bookings/route.ts'),
      ),
      true,
    );
    const routeModule = await import('../app/api/links/[token]/bookings/route');
    assert.equal(typeof routeModule.POST, 'function');
  });
});
