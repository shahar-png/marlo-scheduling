import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { setAvailableTimesCalendarProvider } from '../app/api/event-types/[slug]/available-times/route';
import { createApiClient } from '../lib/api/client';
import { createHandlerTransport } from '../lib/api/handler-transport';
import { encodePathSegment, publicBookingPath } from '../lib/api/public-path';
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
import { resetRuntime, setRuntimeOverride } from '../lib/booking/runtime';
import { createMockCalendar, type MockCalendar } from '../lib/google/mock-calendar';
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
  let mockCalendar: MockCalendar;

  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
    setAvailableTimesCalendarProvider(null);
    // A `one_on_one` create now runs the shared C6 lifecycle, which reads the
    // **runtime** clock and holds slots durably: pin the clock to the fixture
    // slot and start each case from a fresh store (C2/C9).
    resetRuntime();
    // Legacy `one_on_one` availability now reads the shared C6.1 occupancy and
    // the shared C7 `events.list` classification, so the external busy the old
    // fixture `freeBusy` supplied is seeded on the runtime's calendar instead.
    mockCalendar = createMockCalendar();
    mockCalendar.seedExternal({
      id: 'external-lunch',
      start: '2026-09-20T14:00:00.000Z',
      end: '2026-09-20T15:00:00.000Z',
    });
    setRuntimeOverride({
      calendar: mockCalendar,
      clock: { now: () => Date.parse(SLOT_0900), sleep: async () => {} },
    });
  });

  it('getSlots reads GET /api/event-types/:slug/available-times and normalises { times }', async () => {
    seedIntro30();
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock('2026-09-01T00:00:00.000Z') });

    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      durationMinutes: 30,
    });

    assert.equal(transport.calls.length, 1);
    assert.match(transport.calls[0].path, /^\/api\/event-types\/intro-30\/available-times\?/);
    assert.ok(result.times.some((slot) => slot.start === SLOT_0900));
    // External busy 14:00–15:00, classified by C7 from the shared calendar.
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
      durationMinutes: 30,
    });
    const slot = result.times.find((row) => row.start === SLOT_0900);
    assert.ok(slot);
    assert.equal(slot.spotsRemaining, 3);
  });

  it('createBooking POSTs { start, invitee } with the C9 key and maps the C3 envelope', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock('2026-09-01T00:00:00.000Z') });

    const result = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      idempotencyKey: crypto.randomUUID(),
    });

    assert.equal(transport.calls.length, 1);
    assert.equal(transport.calls[0].method, 'POST');
    assert.equal(transport.calls[0].path, '/api/event-types/intro-30/bookings');
    assert.deepEqual(transport.calls[0].body, {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.ok(transport.calls[0].headers?.['idempotency-key']);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // C11: the token is mapped from `booking.token` and is never the id.
    assert.ok(result.booking.id);
    assert.ok(result.booking.token);
    assert.notEqual(result.booking.id, result.booking.token);
    assert.equal(result.booking.start, SLOT_0900);
    assert.equal(result.booking.end, '2026-09-20T09:30:00.000Z');
    assert.equal(result.booking.status, 'confirmed');
  });

  it('createBooking without the C9 key is a typed failure, not a booking', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
    const api = createApiClient({
      transport: createHandlerTransport(),
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
    assert.equal(result.status, 400);
    assert.equal(result.error, 'idempotency_key_required');
  });

  it('createBooking maps 409 slot_unavailable to its typed code', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
    const api = createApiClient({
      transport: createHandlerTransport(),
      now: fixedClock('2026-09-01T00:00:00.000Z'),
    });
    const taken = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_0900,
      invitee: { name: 'First', email: 'first@example.com' },
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(taken.ok, true);
    // The slot is held from T1, so a second create for it is 409 (C6.1).
    const result = await api.createBooking({
      slug: 'intro-30',
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      idempotencyKey: crypto.randomUUID(),
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
      idempotencyKey: crypto.randomUUID(),
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    // C11: `GET /api/bookings/{id}` takes the **id** and needs the bearer
    // token, so the token-only legacy read finds nothing for a durable row.
    assert.equal(await api.getBooking(created.booking.token), null);
    const authed = await api.getBookingById({
      id: created.booking.id,
      token: created.booking.token,
    });
    assert.equal(authed?.token, created.booking.token);
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
      durationMinutes: 30,
    });

    const url = new URL(transport.calls[0].path, 'http://localhost');
    assert.equal(url.searchParams.get('timeMin'), NOW);
    assert.notEqual(url.searchParams.get('timeMin'), MONTH_MIN);
    // Outgoing timeMax is widened by the duration (BOOK-FE-12).
    assert.equal(url.searchParams.get('timeMax'), '2026-10-01T00:30:00.000Z');
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
      durationMinutes: 30,
    });

    assert.deepEqual(result, { times: [] });
    assert.equal(transport.calls.length, 0);

    // Same guard against a raw stub that would record any call. `now ===
    // timeMax` with a 30-min duration: the widening must not un-elapse the
    // window (BOOK-FE-12 — the guard keys off the ORIGINAL timeMax).
    const stub = stubTransport(() => ({ status: 200, body: { times: [SLOT_0900] } }));
    const stubbed = createApiClient({ transport: stub, now: fixedClock(MONTH_MAX) });
    assert.deepEqual(
      await stubbed.getSlots({ slug: 'intro-30', timeMin: MONTH_MIN, timeMax: MONTH_MAX, durationMinutes: 30 }),
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
      durationMinutes: 30,
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
      durationMinutes: 30,
      now: fixedClock('2026-09-20T10:30:00.000Z'),
    });
    assert.deepEqual(result.times, []);
  });
});

describe('BOOK-FE-12 month window is a window of starts: adapter widens the end bound', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
    setAvailableTimesCalendarProvider(null);
  });

  // Asia/Kathmandu (UTC+5:45, no DST): local September ends 2026-09-30T18:15Z.
  const KTM_SEP_MIN = '2026-08-31T18:15:00.000Z';
  const KTM_SEP_MAX = '2026-09-30T18:15:00.000Z';
  const KTM_OCT_MAX = '2026-10-31T18:15:00.000Z';
  const LAST_START = '2026-09-30T18:00:00.000Z'; // Sep 30 23:45 local; ends 18:30Z
  const NOW = '2026-09-30T00:00:00.000Z';

  function seedWeekdayIntro30() {
    const schedule = createAvailabilitySchedule({
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '20:00' })),
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

  it('(m) a meeting crossing local month-end is returned by the adapter through the existing handler', async () => {
    seedWeekdayIntro30();
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock(NOW) });

    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: KTM_SEP_MIN,
      timeMax: KTM_SEP_MAX,
      durationMinutes: 30,
    });

    const starts = result.times.map((slot) => slot.start);
    assert.ok(starts.includes(LAST_START), '18:00Z start is offered under September');
    assert.ok(
      starts.every((start) => Date.parse(start) < Date.parse(KTM_SEP_MAX)),
      'no start at or after the logical September bound',
    );
    const url = new URL(transport.calls[0].path, 'http://localhost');
    assert.equal(url.searchParams.get('timeMin'), NOW);
    assert.equal(url.searchParams.get('timeMax'), '2026-09-30T18:45:00.000Z');
  });

  it('(m) negative control: the raw handler with the unwidened timeMax drops 18:00Z', async () => {
    seedWeekdayIntro30();
    const transport = createHandlerTransport();
    const raw = await transport({
      method: 'GET',
      path: `/api/event-types/intro-30/available-times?timeMin=${NOW}&timeMax=${KTM_SEP_MAX}`,
    });
    assert.equal(raw.status, 200);
    const times = (raw.body as { times: string[] }).times;
    assert.ok(times.includes('2026-09-30T17:30:00.000Z'));
    assert.equal(
      times.includes(LAST_START),
      false,
      'if this starts passing, the backend end-bound rule changed and the widening is redundant',
    );
  });

  it('(m) the October window through the adapter does not also list 18:00Z', async () => {
    seedWeekdayIntro30();
    const api = createApiClient({ transport: createHandlerTransport(), now: fixedClock(NOW) });
    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: KTM_SEP_MAX,
      timeMax: KTM_OCT_MAX,
      durationMinutes: 30,
    });
    const starts = result.times.map((slot) => slot.start);
    assert.equal(starts.includes(LAST_START), false);
    assert.ok(starts.every((start) => Date.parse(start) >= Date.parse(KTM_SEP_MAX)));
  });

  it('widening never leaks the next month: starts at timeMax and timeMax + 15 min are filtered out', async () => {
    const transport = stubTransport(() => ({
      status: 200,
      body: { times: [LAST_START, KTM_SEP_MAX, '2026-09-30T18:30:00.000Z'] },
    }));
    const api = createApiClient({ transport, now: fixedClock(NOW) });
    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: KTM_SEP_MIN,
      timeMax: KTM_SEP_MAX,
      durationMinutes: 30,
    });
    assert.deepEqual(result.times.map((slot) => slot.start), [LAST_START]);
    const url = new URL(transport.calls[0].path, 'http://localhost');
    assert.equal(url.searchParams.get('timeMax'), '2026-09-30T18:45:00.000Z');
  });

  it('empty-range guard keys off the original timeMax: now = timeMax returns empty with zero backend calls', async () => {
    const transport = stubTransport(() => ({ status: 200, body: { times: [LAST_START] } }));
    const api = createApiClient({ transport, now: fixedClock(KTM_SEP_MAX) });
    const result = await api.getSlots({
      slug: 'intro-30',
      timeMin: KTM_SEP_MIN,
      timeMax: KTM_SEP_MAX,
      durationMinutes: 30,
    });
    assert.deepEqual(result, { times: [] });
    assert.equal(transport.calls.length, 0);
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
    // BOOK-FE-12: the end-bound divergence section.
    assert.match(text, /timeMax/);
    assert.match(text, /duration/);
    assert.match(text, /Kathmandu/);
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

describe('AC-11 safe public paths (BOOK-FE-19)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
    setAvailableTimesCalendarProvider(null);
  });

  it('(a) helper table: encodePathSegment / publicBookingPath encode representable segments and reject the rest', () => {
    assert.equal(encodePathSegment('intro-30'), 'intro-30');
    assert.equal(encodePathSegment('café 30'), 'caf%C3%A9%2030');
    for (const rejected of [
      '',
      '.',
      '..',
      'intro#follow-up',
      'intro?x=1',
      'intro/30',
      'intro\\30',
      'intro\n30',
      'intro\u0000',
      'intro\u007f',
      '\uD800',
    ]) {
      assert.equal(encodePathSegment(rejected), null, JSON.stringify(rejected));
    }
    assert.equal(publicBookingPath('demo', 'intro-30'), '/demo/intro-30');
    assert.equal(publicBookingPath('demo', 'café 30'), '/demo/caf%C3%A9%2030');
    assert.equal(publicBookingPath('demo', 'intro#follow-up'), null);
    assert.equal(publicBookingPath('de/mo', 'intro-30'), null);
    assert.equal(publicBookingPath('', 'intro-30'), null);
    assert.equal(publicBookingPath('demo', '..'), null);
  });

  it('(d) a rejected slug never reaches the backend: getSlots is empty and createBooking is unknown-coded, zero calls', async () => {
    const transport = createHandlerTransport();
    const api = createApiClient({ transport, now: fixedClock('2026-09-01T00:00:00.000Z') });

    const slots = await api.getSlots({
      slug: 'intro#follow-up',
      timeMin: MONTH_MIN,
      timeMax: MONTH_MAX,
      durationMinutes: 30,
    });
    assert.deepEqual(slots, { times: [] });
    assert.equal(transport.calls.length, 0);

    const created = await api.createBooking({
      slug: 'intro#follow-up',
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(created.ok, false);
    assert.equal(created.ok === false && created.code, UNKNOWN_ERROR);
    assert.equal(transport.calls.length, 0);

    // The same through a stub that would happily answer — still no request.
    const stub = stubTransport(() => ({ status: 200, body: { times: [SLOT_0900] } }));
    const stubbed = createApiClient({ transport: stub, now: fixedClock('2026-09-01T00:00:00.000Z') });
    for (const slug of ['intro?x=1', 'intro/30', 'a\\b', '']) {
      assert.deepEqual(
        await stubbed.getSlots({ slug, timeMin: MONTH_MIN, timeMax: MONTH_MAX, durationMinutes: 30 }),
        { times: [] },
      );
    }
    assert.equal(stub.calls.length, 0);
  });

  it('(d) a representable slug is percent-encoded, never interpolated raw', async () => {
    const stub = stubTransport(() => ({ status: 200, body: { times: [] } }));
    const api = createApiClient({ transport: stub, now: fixedClock('2026-09-01T00:00:00.000Z') });

    await api.getSlots({ slug: 'café 30', timeMin: MONTH_MIN, timeMax: MONTH_MAX, durationMinutes: 30 });
    assert.equal(stub.calls.length, 1);
    const encodedPath = stub.calls[0].path;
    assert.ok(encodedPath.includes('/api/event-types/caf%C3%A9%2030/available-times'), encodedPath);
    assert.equal(encodedPath.includes(' '), false);
    assert.equal(encodedPath.includes('é'), false);

    await api.getSlots({ slug: 'intro-30', timeMin: MONTH_MIN, timeMax: MONTH_MAX, durationMinutes: 30 });
    assert.equal(stub.calls.length, 2);
    assert.ok(stub.calls[1].path.includes('/api/event-types/intro-30/available-times'));

    await api.createBooking({
      slug: 'café 30',
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(stub.calls.length, 3);
    assert.equal(stub.calls[2].path, '/api/event-types/caf%C3%A9%2030/bookings');
  });

  it('(e) source: the client helper encodes through encodePathSegment; the server adapter imports publicBookingPath', () => {
    const client = readFileSync(path.join(process.cwd(), 'lib/api/client.ts'), 'utf8');
    assert.match(client, /encodePathSegment\(/);
    assert.doesNotMatch(client, /\/api\/event-types\/\$\{slug\}/);
    assert.doesNotMatch(client, /\/api\/event-types\/\$\{input\.slug\}/);
    assert.doesNotMatch(client, /encodeURIComponent\(input\.slug\)/);

    const server = readFileSync(path.join(process.cwd(), 'lib/api/server.ts'), 'utf8');
    assert.match(server, /import \{ publicBookingPath \} from '\.\/public-path'/);
    assert.doesNotMatch(server, /`\/\$\{/);
    assert.doesNotMatch(server, /\$\{eventType\.slug\}/);
    assert.doesNotMatch(server, /\$\{host\.slug\}/);

    const publicPath = readFileSync(path.join(process.cwd(), 'lib/api/public-path.ts'), 'utf8');
    assert.doesNotMatch(publicPath, /\bfetch\(/);
    assert.doesNotMatch(publicPath, /use client/);
    // Pure: no imports at all (the Server page imports it too).
    assert.doesNotMatch(publicPath, /^import /m);
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
