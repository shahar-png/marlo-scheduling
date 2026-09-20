import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { setAvailableTimesCalendarProvider } from '../app/api/event-types/[slug]/available-times/route';
import { createApiClient } from '../lib/api/client';
import { createHandlerTransport } from '../lib/api/handler-transport';
import type { ApiRequest, Transport } from '../lib/api/transport';
import { SESSION_FULL, SLOT_UNAVAILABLE, UNKNOWN_ERROR } from '../lib/api/types';
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

// Existing BOOK-core fixture semantics: 2026-09-20 (a Sunday) 09:00–20:00 UTC.
const SLOT_0900 = '2026-09-20T09:00:00.000Z';
const SLOT_1000 = '2026-09-20T10:00:00.000Z';
const MONTH_MIN = '2026-09-01T00:00:00.000Z';
const MONTH_MAX = '2026-10-01T00:00:00.000Z';

const fixedClock = (iso: string) => () => new Date(iso);

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

function seedGroup(maxInvitees: number) {
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

function stubTransport(
  respond: (request: ApiRequest) => { status: number; body: unknown },
): Transport & { calls: ApiRequest[] } {
  const calls: ApiRequest[] = [];
  const transport = (async (request: ApiRequest) => {
    calls.push(request);
    return respond(request);
  }) as Transport & { calls: ApiRequest[] };
  transport.calls = calls;
  return transport;
}

describe('AC-3 lib/api adapters map to the existing handlers', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
    setAvailableTimesCalendarProvider(null);
  });

  it('getSlots reads GET /api/event-types/:slug/available-times and normalises { times }', async () => {
    seedIntro30();
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock('2026-09-01T00:00:00.000Z') });

    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
    });

    assert.equal(transport.calls.length, 1);
    assert.match(transport.calls[0].path, /^\/api\/event-types\/intro-30\/available-times\?/);
    assert.ok(result.times.some((slot) => slot.start === SLOT_0900));
    // Fixture busy 14:00–15:00 is excluded by the existing slot engine.
    assert.equal(result.times.some((slot) => slot.start === '2026-09-20T14:00:00.000Z'), false);
    assert.equal(result.times[0].spotsRemaining, undefined);
  });

  it('getSlots surfaces group spots_remaining as spotsRemaining', async () => {
    seedGroup(3);
    const api = createApiClient({
      transport: createHandlerTransport(),
      now: fixedClock('2026-09-01T00:00:00.000Z'),
    });
    const result = await api.getSlots({
      slug: 'workshop',
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
    });
    const slot = result.times.find((row) => row.start === SLOT_0900);
    assert.ok(slot);
    assert.equal(slot.spotsRemaining, 3);
  });

  it('createBooking POSTs { start, invitee } and maps 201 booking.id to token', async () => {
    seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    setBookingCalendarProvider(provider);
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock('2026-09-01T00:00:00.000Z') });

    const result = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });

    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].method, 'POST');
    assert.equal(transport.calls[0].path, '/api/event-types/intro-30/bookings');
    assert.deepEqual(transport.calls[0].body, {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const bookings = listConfirmedBookingsForHost('host-1');
    assert.equal(bookings.length, 1);
    assert.equal(result.booking.token, bookings[0].id);
    assert.equal(result.booking.start, SLOT_0900);
    assert.equal(result.booking.end, '2026-09-20T09:30:00.000Z');
    assert.equal(result.booking.status, 'confirmed');
    assert.equal(provider.createdEvents.length, 1);
  });

  it('createBooking maps 409 slot_unavailable to its typed code', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
    const api = createApiClient({
      transport: createHandlerTransport(),
      now: fixedClock('2026-09-01T00:00:00.000Z'),
    });
    const result = await api.createBooking({
      slug: 'intro-30',
      start: '2026-09-20T14:00:00.000Z', // fixture busy
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.deepEqual(result, { ok: false, code: SLOT_UNAVAILABLE });
  });

  it('BOOK-FE-07: createBooking maps 409 session_full to a distinct typed code', async () => {
    const group = seedGroup(1);
    const provider = createFixtureCalendarProvider(FIXTURE);
    setBookingCalendarProvider(provider);
    await bookAvailableSlot({
      eventType: group,
      start: SLOT_0900,
      invitee: { name: 'First', email: 'first@example.com' },
      provider,
      calendarId: 'primary',
    });

    const api = createApiClient({
      transport: createHandlerTransport(),
      now: fixedClock('2026-09-01T00:00:00.000Z'),
    });
    const result = await api.createBooking({
      slug: 'workshop',
      start: SLOT_0900,
      invitee: { name: 'Second', email: 'second@example.com' },
    });
    assert.deepEqual(result, { ok: false, code: SESSION_FULL });
    assert.notEqual(SESSION_FULL, SLOT_UNAVAILABLE);
  });

  it('BOOK-FE-07: an unrecognised 409 body is not coerced to slot_unavailable', async () => {
    const api = createApiClient({
      transport: stubTransport(() => ({ status: 409, body: { error: 'something_else' } })),
      now: fixedClock('2026-09-01T00:00:00.000Z'),
    });
    const result = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.code, UNKNOWN_ERROR);
    assert.notEqual(result.code, SLOT_UNAVAILABLE);
  });

  it('getBooking reads GET /api/bookings/:id and returns null on 404', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
    const api = createApiClient({
      transport: createHandlerTransport(),
      now: fixedClock('2026-09-01T00:00:00.000Z'),
    });
    const created = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const found = await api.getBooking(created.booking.token);
    assert.equal(found?.token, created.booking.token);
    assert.equal(await api.getBooking('missing-token'), null);
  });
});

describe('AC-7 past-slot cutoff in the adapter (fixed clock)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
    setAvailableTimesCalendarProvider(null);
  });

  it('(a) clamps timeMin to now for the current month and filters elapsed starts', async () => {
    seedIntro30();
    const NOW = '2026-09-20T09:45:00.000Z';
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock(NOW) });

    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: MONTH_MIN,
      timeMax: MONTH_MAX,
    });

    const url = new URL(transport.calls[0].path, 'http://localhost');
    assert.equal(url.searchParams.get('timeMin'), NOW);
    assert.notEqual(url.searchParams.get('timeMin'), MONTH_MIN);
    assert.equal(url.searchParams.get('timeMax'), MONTH_MAX);
    assert.equal(result.times.some((slot) => slot.start === SLOT_0900), false);
    assert.ok(result.times.every((slot) => Date.parse(slot.start) >= Date.parse(NOW)));
    assert.ok(result.times.some((slot) => slot.start === SLOT_1000));
  });

  it('(d) expired window: now >= timeMax returns empty availability without calling the backend', async () => {
    seedIntro30();
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock('2026-10-05T12:00:00.000Z') });

    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: MONTH_MIN,
      timeMax: MONTH_MAX,
    });

    assert.deepEqual(result, { times: [] });
    assert.equal(transport.calls.length, 0);

    // Same guard against a raw stub that would record any call.
    const stub = stubTransport(() => ({ status: 200, body: { times: [SLOT_0900] } }));
    const stubbed = createApiClient({ transport: stub, now: fixedClock(MONTH_MAX) });
    assert.deepEqual(
      await stubbed.getSlots({ slug: 'intro-30', timeMin: MONTH_MIN, timeMax: MONTH_MAX }),
      { times: [] },
    );
    assert.equal(stub.calls.length, 0);
  });

  it('createBooking with start < now returns slot_unavailable without touching the backend', async () => {
    const transport = stubTransport(() => ({ status: 201, body: {} }));
    const api = createApiClient({ transport, now: fixedClock('2026-09-20T10:30:00.000Z') });
    const result = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_1000,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.deepEqual(result, { ok: false, code: SLOT_UNAVAILABLE });
    assert.equal(transport.calls.length, 0);
  });

  it('BOOK-FE-06: reads the clock fresh on resolve — 09:59 at request, 10:01 on resolve drops 10:00', async () => {
    let calls = 0;
    const now = () => {
      calls += 1;
      return new Date(calls === 1 ? '2026-09-20T09:59:00.000Z' : '2026-09-20T10:01:00.000Z');
    };
    const transport = stubTransport(() => ({
      status: 200,
      body: { times: [SLOT_1000, '2026-09-20T10:30:00.000Z'] },
    }));
    const api = createApiClient({ transport, now });

    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: MONTH_MIN,
      timeMax: MONTH_MAX,
    });

    const url = new URL(transport.calls[0].path, 'http://localhost');
    assert.equal(url.searchParams.get('timeMin'), '2026-09-20T09:59:00.000Z');
    assert.deepEqual(result.times.map((slot) => slot.start), ['2026-09-20T10:30:00.000Z']);
    assert.ok(calls >= 2);
  });

  it('per-call now overrides the client clock', async () => {
    const transport = stubTransport(() => ({ status: 200, body: { times: [SLOT_1000] } }));
    const api = createApiClient({ transport, now: fixedClock('2026-09-01T00:00:00.000Z') });
    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: MONTH_MIN,
      timeMax: MONTH_MAX,
      now: fixedClock('2026-09-20T10:30:00.000Z'),
    });
    assert.deepEqual(result.times, []);
  });
});

describe('AC-3 DIVERGENCES.md and no fetch in app components', () => {
  it('lib/api/DIVERGENCES.md exists and names the path diffs and the missing idempotency key', () => {
    const file = path.join(process.cwd(), 'lib/api/DIVERGENCES.md');
    assert.equal(existsSync(file), true);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /\/public\//);
    assert.match(text, /\/api\/event-types/);
    assert.match(text, /times/);
    assert.match(text, /days/);
    assert.match(text, /token/);
    assert.match(text, /\berror\b/);
    assert.match(text, /\bcode\b/);
    assert.match(text, /idempotency/i);
    assert.match(text, /Idempotency-Key/);
    assert.match(text, /retry/i);
  });

  it('app/**/*.tsx never calls fetch(', () => {
    const files = listTsx(path.join(process.cwd(), 'app'));
    assert.ok(files.length > 0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      assert.doesNotMatch(source, /\bfetch\(/, `${file} must not call fetch(`);
    }
  });
});

function listTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listTsx(full));
    } else if (full.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}
