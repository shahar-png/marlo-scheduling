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
import { resetBookings } from '../lib/booking/booking';
import type { MemoryBookingStore } from '../lib/booking/memory-store';
import {
  memoryRuntimeHandle,
  resetRuntime,
  setRuntimeOverride,
} from '../lib/booking/runtime';
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

// C2/C9: a `one_on_one` legacy create runs the shared demo-scoped lifecycle,
// so it carries an `Idempotency-Key` like every other create entry point. The
// header is omitted only where a case is asserting its absence.
function bookingRequest(
  slug: string,
  body: unknown,
  options: { idempotencyKey?: string | null } = {},
): Promise<Response> {
  const key =
    options.idempotencyKey === undefined ? crypto.randomUUID() : options.idempotencyKey;
  return POST(
    new Request(`http://localhost/api/event-types/${slug}/bookings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

/** The shared lifecycle reads the clock, so the fixture slot must be "now". */
function pinClockTo(iso: string): void {
  setRuntimeOverride({
    clock: { now: () => Date.parse(iso), sleep: async () => {} },
  });
}

describe('AC-5 POST /api/event-types/:slug/bookings', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    setBookingCalendarProvider(null);
    // The durable memory runtime is a process singleton; a fresh one per case
    // keeps one test's booking from occupying the next one's slot.
    resetRuntime();
    pinClockTo(SLOT_0900);
  });

  it('returns 201 and the C3 envelope for a free slot, with a distinct id and token', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const response = await bookingRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      booking: {
        id: string;
        token: string;
        status: string;
        start: string;
        end: string;
        revision: number;
        invitee: { name: string; email: string };
      };
      delivery: { email: string; calendar: string };
    };
    assert.equal(body.booking.status, 'confirmed');
    assert.equal(body.booking.start, SLOT_0900);
    assert.equal(body.booking.end, '2026-09-20T09:30:00.000Z');
    assert.deepEqual(body.booking.invitee, {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    });
    // C11: a legacy `one_on_one` create now yields the id/token split, so the
    // row it produces is not readable without its bearer token.
    assert.ok(body.booking.id);
    assert.ok(body.booking.token);
    assert.notEqual(body.booking.id, body.booking.token);
    assert.equal(body.booking.revision, 1);
    assert.equal(body.delivery.calendar, 'created');
  });

  it('requires the C9 key for a one_on_one create (C2 / AC-24(f))', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const response = await bookingRequest(
      'intro-30',
      { start: SLOT_0900, invitee: { name: 'Ada', email: 'ada@example.com' } },
      { idempotencyKey: null },
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'idempotency_key_required' });
  });

  it('replays the same key to the same booking rather than a second row', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
    const key = crypto.randomUUID();
    const payload = {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    };

    const first = await bookingRequest('intro-30', payload, { idempotencyKey: key });
    const replay = await bookingRequest('intro-30', payload, { idempotencyKey: key });

    assert.equal(first.status, 201);
    assert.equal(replay.status, 201);
    const a = (await first.json()) as { booking: { id: string; token: string } };
    const b = (await replay.json()) as { booking: { id: string; token: string } };
    assert.equal(a.booking.id, b.booking.id);
    assert.equal(a.booking.token, b.booking.token);
  });

  it('returns 409 on conflict, 404 for an unknown slug, and 400 for a missing body', async () => {
    seedIntro30();
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    // The shared lifecycle holds the slot from T1, so booking it twice is a
    // 409 `slot_unavailable` — the C6.1 occupancy rule, not a fixture's
    // freeBusy window.
    const first = await bookingRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
    });
    assert.equal(first.status, 201);
    const conflict = await bookingRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
    });
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: 'slot_unavailable' });

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
    // The shared lifecycle serialises on the per-host lock and holds the slot
    // from T1, so exactly one of the two rows exists (C6.1).
    assert.equal(await confirmedDurableBookings('host-1'), 1);
  });
});

/** Rows in the durable store the shared lifecycle writes to. */
async function confirmedDurableBookings(hostId: string): Promise<number> {
  const store = memoryRuntimeHandle().store as MemoryBookingStore;
  return store
    .allRows()
    .filter((row) => row.hostId === hostId && row.status === 'confirmed').length;
}
