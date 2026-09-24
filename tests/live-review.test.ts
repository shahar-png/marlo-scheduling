// The contract points the LIVE-REVIEW round found unproved. Each case here is
// the observable consequence of one rule, driven through the real lifecycle:
//
//   * a terminal create rejection is fenced **whatever produced it** (C6.4);
//   * a lifecycle send never claims a `(revision, action)` the row never held (C5);
//   * an abandoned reschedule's reservation dies with its op (C6.1/C6.7);
//   * a one-off link booking is readable and cancellable at `/b/{token}` (C10);
//   * memory-mode `group`/`collective` take their fixture path on **every**
//     create entry point, before the key check (C2/C6.9);
//   * a ledger failure after T2 leaves the booking committed (AC-10/C5);
//   * an unproven observation never writes a repair off as failed (C6.0/C6.8).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POST as ownerBookingsPOST } from '../app/api/owners/[ownerSlug]/event-types/[eventSlug]/bookings/route';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { createSingleUseLink, resetSingleUseLinks } from '../lib/availability/single-use-link';
import { createOneOffMeeting, resetOneOffMeetings } from '../lib/availability/one-off';
import { GET as bookingGET } from '../app/api/bookings/[id]/route';
import { createEventType, GROUP } from '../lib/availability/event-type';
import { errorResponse } from '../lib/api/route-helpers';
import {
  DatabaseUnavailableError,
  ensureDatabase,
  inTransaction,
  setDatabase,
  TransactionAbortedError,
  UnknownCommitError,
} from '../lib/db/index';
import { setEnvOverride } from '../lib/env';
import { AvailabilityUnknownError } from '../lib/google/errors';
import { eventTypeIdFor, ownerIdForSlug, type Owner } from '../lib/owners';
import { bookSingleUseLink, resetBookings } from '../lib/booking/booking';
import {
  bookingAvailability,
  cancelBooking,
  createBooking,
  notifyBooking,
  readBooking,
  rescheduleBooking,
  scopeForRow,
} from '../lib/booking/service';
import { createLiveCalendar } from '../lib/google/live-calendar';
import { classifyCalendarError } from '../lib/google/errors';
import { sendBookingEmails } from '../lib/notify/send';
import { LifecycleError } from '../lib/booking/errors';
import { lifecycleLogCount } from '../lib/booking/log';
import { acquireStaleOp } from '../lib/booking/ops';
import type { BookingRow } from '../lib/booking/rows';
import { MemoryBookingStore } from '../lib/booking/memory-store';
import type { BookingStore } from '../lib/booking/store';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { getRuntime, resetRuntime, setRuntimeOverride } from '../lib/booking/runtime';
import { createFakeDatabase } from './support/pg-fake';
import {
  advancePastStaleWindow,
  bothStores,
  DEMO,
  isoAt,
  MONDAY_0900,
  teardown,
  withHarness,
  type Harness,
} from './support/harness';

const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };
const ORIGIN = 'https://marlo.test';

async function book(start = MONDAY_0900, key = crypto.randomUUID()) {
  return createBooking({
    ownerSlug: DEMO.ownerSlug,
    eventSlug: DEMO.eventSlug,
    start,
    invitee: INVITEE,
    notes: null,
    idempotencyKey: key,
    origin: ORIGIN,
  });
}

async function scopeOf(harness: Harness, id: string) {
  const row = await harness.store.getById(id);
  assert.ok(row !== null);
  return scopeForRow(row, harness.runtime);
}

async function expectError(fn: () => Promise<unknown>): Promise<LifecycleError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof LifecycleError, `expected LifecycleError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('C6.4 — every terminal create rejection is durably fenced (REV8-01)', () => {
  for (const [label, start] of [
    ['an elapsed start', isoAt(-60)],
    ['an off-grid start', isoAt(7)],
  ] as const) {
    it(`fences ${label} in the rejecting T1, like an occupancy conflict`, async () => {
      await bothStores(async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        const key = crypto.randomUUID();

        const rejected = await expectError(() => book(start, key));
        assert.equal(rejected.code, 'slot_unavailable');
        assert.equal(rejected.status, 409);
        // A start nobody offered costs no Google call either.
        assert.equal(harness.calendar.calls.length, 0);

        // The fence is what makes it terminal: repeating the same key and
        // payload is answered from the fence, never re-evaluated — so an
        // attempt paused before its own T1 can never insert after the client
        // cleared its key on this 409 (LIVE-REVIEW-03).
        const repeated = await expectError(() => book(start, key));
        assert.equal(repeated.code, 'slot_unavailable');
        assert.equal(lifecycleLogCount('create_fenced') > 0, true);

        // Per `(key, fingerprint)`, not per key: an offered slot still books.
        const booked = await book(MONDAY_0900, key);
        assert.equal(booked.envelope.booking.status, 'confirmed');
      });
    });
  }
});

describe('C5 — a lifecycle send never claims a pair the booking never held', () => {
  it('refuses a (later revision, earlier action) pair without writing a row', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book();

      // The booking moves on to revision 2 / `cancel`.
      await cancelBooking(await scopeOf(harness, created.row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });
      const before = harness.sender.sent.length;

      // A create worker that read the row *after* that commit would carry
      // revision 2 under its own `confirm` — a pair the row never had. Claiming
      // it would corrupt the ledger (LIVE-REVIEW-06); an *earlier* pair is the
      // accepted stale-email window of C5 and is still allowed.
      const invented = await sendBookingEmails(
        {
          store: harness.store,
          sender: harness.sender,
          nowMs: harness.clock.now(),
          origin: ORIGIN,
          from: 'marlo@example.com',
        },
        {
          bookingId: created.row.id,
          revision: 2,
          action: 'confirm',
          template: templateFor(created.row),
        },
      );
      assert.deepEqual(invented.claimed, []);
      assert.equal(harness.sender.sent.length, before, 'nothing was sent');

      // A `failed` row is re-claimable **immediately** (C5/REV7-04), so the
      // superseded pair below is claimable unless the validation and the claim
      // happen in one locked transaction.
      for (const recipient of ['invitee', 'owner'] as const) {
        await harness.store.finalizeDelivery({
          bookingId: created.row.id,
          revision: 1,
          action: 'confirm',
          recipient,
          gen: 1,
          state: 'failed',
        });
      }

      const historical = await sendBookingEmails(
        {
          store: harness.store,
          sender: harness.sender,
          nowMs: harness.clock.now(),
          origin: ORIGIN,
          from: 'marlo@example.com',
        },
        {
          bookingId: created.row.id,
          revision: 1,
          action: 'confirm',
          template: templateFor(created.row),
        },
      );
      // C5 accepts an **already-claimed** send arriving late; it does not
      // accept *acquiring* a claim for a pair a later revision has superseded —
      // which is exactly what a create worker paused after its T2 would do here
      // (REVIEW-06). Notify's N-3 refuses the same pair before claiming.
      assert.deepEqual(historical.claimed, []);
      assert.equal(harness.sender.sent.length, before, 'still nothing was sent');
    });
  });

  it('keeps a committed booking committed when the ledger itself fails (AC-10)', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // The business transaction succeeds; the delivery ledger is unreachable.
      const broken: BookingStore = Object.create(harness.store) as BookingStore;
      Object.assign(broken, {
        claimDelivery: async () => {
          throw new Error('ledger unavailable');
        },
      });
      setRuntimeOverride({ ...harness.runtime, store: broken });

      const created = await book();
      assert.equal(created.envelope.booking.status, 'confirmed');
      // Delivery is *unresolved*, never a failure of the booking.
      assert.equal(created.envelope.delivery.email, 'pending');
      assert.equal(created.envelope.delivery.calendar, 'created');
      assert.ok(lifecycleLogCount('delivery_claim_failed') >= 1);
    });
  });
});

describe('C6.1/C6.7 — an abandoned reschedule releases its destination', () => {
  it('clears the reservation in the transaction that replaces its op', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book();
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);

      // A reschedule that reserved its destination and died before its patch.
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            pendingOp: {
              kind: 'reschedule',
              opId: 'op-dead',
              gen: 1,
              startedAt: new Date(harness.clock.now()).toISOString(),
              newStart: isoAt(30),
              newEnd: isoAt(60),
              oldEventId: row.googleEventId ?? undefined,
              fallbackEventId: 'marlofallbackbbb',
              attempts: [],
            },
            reservedStart: isoAt(30),
            reservedEnd: isoAt(60),
          },
        });
      });
      await advancePastStaleWindow(harness.clock);

      // The cancel's delete is definitely refused, so it ends at T2′ — the one
      // path on which the abandoned destination could otherwise stay occupied
      // with no operation able to reconcile it (LIVE-REVIEW-07).
      const scope = await scopeOf(harness, row.id);
      harness.calendar.failNext('delete', { status: 403 });
      const refused = await expectError(() =>
        cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(refused.code, 'calendar_delete_failed');

      const after = await harness.store.getById(row.id);
      assert.ok(after !== null);
      assert.equal(after.reservedStart, null, 'the destination is free again');
      assert.equal(after.reservedEnd, null);

      // And the interval it held is genuinely bookable again.
      const other = await book(isoAt(30));
      assert.equal(other.envelope.booking.start, isoAt(30));
    });
  });
});

describe('C10 — a link booking is readable and cancellable at /b/{token}', () => {
  it('resolves a one-off row whose synthetic event type is not in the catalog', async () => {
    await withHarness('memory', async (harness) => {
      resetOneOffMeetings();
      resetSingleUseLinks();
      resetBookings();
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      const meeting = createOneOffMeeting({
        hostId: DEMO.ownerId,
        name: 'Offsite',
        durationMinutes: 30,
        timezone: 'UTC',
        windows: [{ date: MONDAY_0900.slice(0, 10), start: '09:00', end: '20:00' }],
      });
      const link = createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'read-me' });

      const outcome = await bookSingleUseLink({
        token: link.token,
        start: isoAt(60),
        invitee: INVITEE,
        provider: createFixtureCalendarProvider({ calendars: {} } as GoogleFreeBusyFixture),
        calendarId: 'primary',
      });

      // The synthetic event type is deliberately never registered, so this is
      // the exact read the row's own description exists for (LIVE-REVIEW-08).
      const envelope = await readBooking(await scopeOf(harness, outcome.row.id));
      assert.equal(envelope.booking.id, outcome.row.id);
      assert.equal(envelope.booking.start, isoAt(60));
      assert.equal(envelope.booking.eventSlug, `one-off-${meeting.id}`);

      // …and the authenticated lifecycle resolves it too.
      const cancelled = await cancelBooking(await scopeOf(harness, outcome.row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal(cancelled.envelope.booking.status, 'cancelled');
    });
  });
});

describe('C2/C6.9 — every create entry point dispatches a fixture kind first', () => {
  it('books a memory-mode group through the owner-scoped route with no key', async () => {
    await withHarness('memory', async (harness) => {
      resetBookings();
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      setBookingCalendarProvider(
        createFixtureCalendarProvider({ calendars: {} } as GoogleFreeBusyFixture),
      );
      createEventType({
        id: eventTypeIdFor(DEMO.ownerSlug, 'workshop'),
        ownerId: DEMO.ownerId,
        hostId: DEMO.ownerId,
        slug: 'workshop',
        name: 'Workshop',
        durationMinutes: 30,
        availabilityScheduleId: DEMO.scheduleId,
        kind: GROUP,
        maxInvitees: 3,
      });

      // No `Idempotency-Key`: the kind gate precedes the header check, and a
      // fixture kind never reaches C9 or the exclusive C6 lifecycle at all
      // (LIVE-REVIEW-10). Before the dispatch existed this was a flat 400.
      const response = await ownerBookingsPOST(
        new Request(`http://localhost/api/owners/${DEMO.ownerSlug}/event-types/workshop/bookings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ start: MONDAY_0900, invitee: INVITEE }),
        }),
        {
          params: Promise.resolve({
            ownerSlug: DEMO.ownerSlug,
            eventSlug: 'workshop',
          }),
        },
      );

      assert.equal(response.status, 201);
      const body = (await response.json()) as { booking: { status: string } };
      assert.equal(body.booking.status, 'confirmed');
      // The fixture path writes no durable row, no fingerprint, no C9 record.
      assert.equal((await harness.store.getById(DEMO.eventTypeId)) ?? null, null);
      setBookingCalendarProvider(null);
    });
  });
});

describe('C6.8 — a repair is never written off on an unproven observation', () => {
  it('answers 503 and keeps the op when the post-409 read is refused', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A definite insert failure finalizes the booking with calendar_state
      // 'failed' — the one state C6.8 repair starts from.
      harness.calendar.failNext('insert', { status: 403 });
      const created = await book();
      assert.equal(created.envelope.delivery.calendar, 'failed');

      // Repair: the insert answers 409 `duplicate` (this request created
      // nothing) and the `events.get` that must decide the op is itself refused
      // — neither presence nor absence is established (LIVE-REVIEW-13).
      const repairScope = await scopeOf(harness, created.row.id);
      harness.calendar.failNext('insert', { status: 409 });
      harness.calendar.failNext('get', { status: 403 });
      const unresolved = await expectError(() => notifyBooking(repairScope, {}, ORIGIN));
      assert.equal(unresolved.code, 'booking_outcome_unknown');

      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      assert.equal(row.pendingOp?.kind, 'calendar_repair', 'the repair stays owned');
      assert.equal(row.calendarState, 'failed');

      // The next notify takes the stale repair over and resolves it (REV4-04).
      await advancePastStaleWindow(harness.clock);
      const repaired = await notifyBooking(
        await scopeOf(harness, created.row.id),
        {},
        ORIGIN,
      );
      assert.equal(repaired.envelope.delivery.calendar, 'created');
    });
  });
});

describe('C6.3 — a takeover acquires ownership, it never steals a live one', () => {
  it('refuses a second acquirer that read the same generation as stale', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A create whose insert is held: the row keeps an open, then stale, op.
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() => book());
      const stale = await onlyBooking(harness);
      assert.equal(stale.pendingOp?.kind, 'create');
      assert.equal(stale.pendingOp?.gen, 1);
      await advancePastStaleWindow(harness.clock);

      // Both callers hold this same snapshot and both saw generation 1 as
      // stale. The first acquires generation 2 and renews `startedAt`.
      const first = await acquireStaleOp(opsContext(harness), stale, ['create']);
      assert.equal(first.state, 'taken');
      assert.equal(first.state === 'taken' ? first.op.gen : null, 2);

      // The second must decide staleness from the row **under the lock**, not
      // from its own pre-lock snapshot — otherwise it takes over the generation
      // the first just established and the op has two live owners (REV-01).
      const second = await acquireStaleOp(opsContext(harness), stale, ['create']);
      assert.equal(second.state, 'busy', 'a live generation is never stolen');
      assert.ok(
        second.state === 'busy' && second.retryAfterSeconds > 0,
        'the refusal carries the remaining stale window',
      );

      // The row still names exactly the generation the first acquirer holds.
      const after = await harness.store.getById(stale.id);
      assert.equal(after?.pendingOp?.gen, 2);

      // …and once that generation goes stale in turn, it is takeable again.
      await advancePastStaleWindow(harness.clock);
      const third = await acquireStaleOp(opsContext(harness), stale, ['create']);
      assert.equal(third.state, 'taken');
      assert.equal(third.state === 'taken' ? third.op.gen : null, 3);
    });
  });

  it('refuses an acquirer whose kind is no longer the one on the row', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() => book());
      const row = await onlyBooking(harness);
      await advancePastStaleWindow(harness.clock);

      const wrongKind = await acquireStaleOp(opsContext(harness), row, ['cancel']);
      assert.equal(wrongKind.state, 'gone');
    });
  });
});

describe('C6.3a — cancel is an observing call even when already cancelled', () => {
  it('reaps a late landing on a repeated cancel instead of returning 200 blind', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      harness.calendar.holdNextInsert({ answer: 'timeout' });
      const key = crypto.randomUUID();
      await expectError(() => book(MONDAY_0900, key));
      const row = await onlyBooking(harness);
      const heldAttemptId = harness.calendar.heldInserts()[0].attemptId;

      await advancePastStaleWindow(harness.clock);
      await book(MONDAY_0900, key);
      await cancelBooking(await scopeOf(harness, row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });

      // The retained insert lands after the cancel released the interval.
      harness.calendar.setCollisionMode('land');
      await harness.calendar.releaseHeld(heldAttemptId);
      assert.equal(harness.calendar.liveEvents().length, 1);

      // A repeated cancel is idempotent — but it is also a designated observing
      // call, so returning 200 before the bounded reap would strand that event
      // on the host's calendar for every later retry (REV-04).
      const repeated = await cancelBooking(await scopeOf(harness, row.id), {
        expectedRevision: 2,
        origin: ORIGIN,
      });
      assert.equal(repeated.envelope.booking.status, 'cancelled');
      assert.equal(harness.calendar.liveEvents().length, 0, 'the late event is reaped');

      const after = await harness.store.getById(row.id);
      assert.ok(after !== null);
      assert.equal(
        after.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
        false,
        'the reaped landing retires exactly its own attempt',
      );
    });
  });
});

describe('C2/P1 — the demo owner stays fixture-backed under live adapters', () => {
  it('never binds `demo` to Google, and still does bind every other owner', async () => {
    const fake = createFakeDatabase();
    setRuntimeOverride(null);
    resetRuntime();
    setDatabase(fake);
    setEnvOverride({
      DATABASE_URL: 'postgres://fake/marlo',
      LIVE_CALENDAR: '1',
      LIVE_EMAIL: '1',
    });
    try {
      const runtime = getRuntime();
      assert.ok(runtime.adaptersFor !== undefined, 'pg mode binds adapters per owner');

      const demo: Owner = {
        id: ownerIdForSlug(DEMO.ownerSlug),
        slug: DEMO.ownerSlug,
        firstName: 'Marlo',
        email: 'demo@example.com',
        calendarId: 'primary',
      };
      // The seed writes `demo` with no `host_tokens` row, so a live adapter here
      // fails closed and `/demo/intro-30` answers `availability_unknown` —
      // exactly what P1/C2 say that route must never do (REV-06).
      const demoAdapters = runtime.adaptersFor!(demo);
      assert.deepEqual(
        await demoAdapters.calendar.list({
          calendarId: 'primary',
          timeMin: MONDAY_0900,
          timeMax: isoAt(60),
        }),
        [],
      );

      const host: Owner = { ...demo, id: ownerIdForSlug('ada'), slug: 'ada', email: 'ada@x.co' };
      const hostAdapters = runtime.adaptersFor!(host);
      await assert.rejects(
        () =>
          hostAdapters.calendar.list({
            calendarId: 'primary',
            timeMin: MONDAY_0900,
            timeMax: isoAt(60),
          }),
        (error: unknown) => error instanceof AvailabilityUnknownError,
        'a real host without a token still fails closed',
      );
    } finally {
      teardown();
    }
  });
});

describe('C13/C6.5 — database and commit failures answer their typed status', () => {
  it('maps a missing driver to 503 store_driver_unavailable, not an untyped 500', () => {
    setDatabase(null);
    setEnvOverride({ DATABASE_URL: 'postgres://nowhere/marlo' });
    try {
      let thrown: unknown;
      try {
        ensureDatabase();
      } catch (error) {
        thrown = error;
      }
      // `loadDriver` throws its own error type; passing it through unchanged
      // escaped `errorResponse` as a 500 (REV-07).
      assert.ok(thrown instanceof DatabaseUnavailableError);
      const mapped = errorResponse(thrown);
      assert.ok(mapped !== null);
      assert.equal(mapped.status, 503);
    } finally {
      setDatabase(null);
      setEnvOverride(null);
    }
  });

  it('maps an unknown commit outcome to 503 booking_outcome_unknown', () => {
    const mapped = errorResponse(new UnknownCommitError(new Error('ECONNRESET')));
    assert.ok(mapped !== null);
    assert.equal(mapped.status, 503);
  });
});

describe('C11 — an id never reveals whether a booking exists', () => {
  it('answers the same status for an existing durable id and an unknown one', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book();
      const real = created.row.id;

      for (const [label, id] of [
        ['existing', real],
        ['unknown', 'bk_does_not_exist'],
      ] as const) {
        const noBearer = await bookingGET(
          new Request(`http://localhost/api/bookings/${id}`),
          { params: Promise.resolve({ id }) },
        );
        assert.equal(noBearer.status, 401, `${label}: no bearer`);
        assert.equal(
          ((await noBearer.json()) as { error: string }).error,
          'token_required',
          `${label}: no bearer`,
        );

        const wrongBearer = await bookingGET(
          new Request(`http://localhost/api/bookings/${id}`, {
            headers: { authorization: 'Bearer not-the-token' },
          }),
          { params: Promise.resolve({ id }) },
        );
        assert.equal(wrongBearer.status, 404, `${label}: wrong bearer`);
        assert.equal(
          ((await wrongBearer.json()) as { error: string }).error,
          'booking_not_found',
          `${label}: wrong bearer`,
        );
      }

      // The real token still works, so the uniformity is not a blanket refusal.
      const authed = await bookingGET(
        new Request(`http://localhost/api/bookings/${real}`, {
          headers: { authorization: `Bearer ${created.row.token}` },
        }),
        { params: Promise.resolve({ id: real }) },
      );
      assert.equal(authed.status, 200);
    });
  });
});

describe('C6.6/C6.7 — an inherited operation is resumed, never re-acquired', () => {
  it('completes a stale calendar_repair the cancel already owns', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A definite insert failure finalizes the create with `calendar_state`
      // `failed`, which is the only state repair runs from (C6.8).
      harness.calendar.failNext('insert', { status: 403 });
      const created = await book();
      assert.equal(created.envelope.delivery.calendar, 'failed');

      // Notify begins the repair; its insert times out, so the op is retained.
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      const repairScope = await scopeOf(harness, created.row.id);
      await expectError(() => notifyBooking(repairScope, {}, ORIGIN));
      const owned = await harness.store.getById(created.row.id);
      assert.equal(owned?.pendingOp?.kind, 'calendar_repair');
      const heldAttemptId = harness.calendar.heldInserts()[0].attemptId;

      // The held insert lands at Google, so the takeover below observes the
      // event present and must COMPLETE the repair it inherited.
      harness.calendar.executeHeld(heldAttemptId);
      await advancePastStaleWindow(harness.clock);

      // Cancel takes the stale repair over in its own T1 and therefore already
      // owns the renewed generation. Completing it by re-acquiring would find
      // that generation not stale and refuse `operation_in_progress` — forever,
      // since every retry renews it again (REVIEW-01).
      const cancelled = await cancelBooking(await scopeOf(harness, created.row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal(cancelled.envelope.booking.status, 'cancelled');
      assert.equal(harness.calendar.liveEvents().length, 0, 'the repaired event is deleted');
    });
  });
});

describe('C7 — the own-booking exclusion never covers a retired id', () => {
  it('keeps a late landing under a fallback-reschedule leftover busy and reaps it', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A first insert that times out, then a replay that applies: the row ends
      // `created` with attempt 1 still listed under the live id (REV5-01).
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      const key = crypto.randomUUID();
      await expectError(() => book(MONDAY_0900, key));
      const row = await onlyBooking(harness);
      const heldAttemptId = harness.calendar.heldInserts()[0].attemptId;
      await advancePastStaleWindow(harness.clock);
      await book(MONDAY_0900, key);

      // A reschedule whose patch 404s falls back to a fresh id, which RETIRES
      // the old one while attempt 1's entry is still retained.
      harness.calendar.failNext('patch', { status: 404 });
      await rescheduleBooking(await scopeOf(harness, row.id), {
        start: isoAt(60),
        expectedRevision: 1,
        origin: ORIGIN,
      });

      // The event under that retired id is still on the host's calendar, and
      // the held first insert may yet land under it too (it is answered 409
      // while a non-cancelled event occupies the id — C6.3a).
      harness.calendar.setCollisionMode('land');
      await harness.calendar.releaseHeld(heldAttemptId);
      assert.equal(harness.calendar.liveEvents().length, 2);

      // The authenticated availability route excludes the booking's OWN
      // occupancy — its live event and its reservation — but a retired id is
      // not that: it is a foreign event on the host's calendar. Excluding it
      // by `marloBookingId` alone offers its interval as free and never reaps
      // it (REVIEW-02).
      const scope = await scopeOf(harness, row.id);
      const times = await bookingAvailability(scope, {
        start: MONDAY_0900,
        end: isoAt(240),
      });
      assert.equal(times.includes(MONDAY_0900), false, 'the retired-id event is busy');

      const after = await harness.store.getById(row.id);
      assert.ok(after !== null);
      const live = harness.calendar.liveEvents();
      assert.equal(live.length, 1, 'and it is reaped');
      assert.equal(live[0].id, after.googleEventId, 'only the live event survives');
      // Attribution is untouched by this fix: the deletion retires the attempt
      // its own event names, and the held one — which may still execute — is
      // never retired by a deletion it did not cause (REV6-01).
      assert.equal(
        after.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
        true,
      );
    });
  });
});

describe('C6.6 — the existing operation is reconciled before any external read', () => {
  it('answers a live op `operation_in_progress` while events.list is down', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() => book());
      const row = await onlyBooking(harness);

      // R0 before the op inspection answers 503 `availability_unknown` for a
      // booking whose operation the caller could have been told about — and,
      // for a move that already landed, would refuse a recovery that needs no
      // availability at all (REVIEW-03).
      harness.calendar.failListWith({ status: 500 });
      const scope = await scopeOf(harness, row.id);
      const error = await expectError(() =>
        rescheduleBooking(scope, {
          start: isoAt(60),
          expectedRevision: 1,
          origin: ORIGIN,
        }),
      );
      assert.equal(error.code, 'operation_in_progress');
    });
  });

  it('completes a stale inherited create during the same outage', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() => book());
      const row = await onlyBooking(harness);
      assert.equal(row.latestAction, null);
      await advancePastStaleWindow(harness.clock);

      harness.calendar.failListWith({ status: 500 });
      // The reschedule itself cannot proceed without availability, but the
      // reconciliation runs first, so the inherited create is finalized.
      const scope = await scopeOf(harness, row.id);
      await expectError(() =>
        rescheduleBooking(scope, {
          start: isoAt(60),
          expectedRevision: 1,
          origin: ORIGIN,
        }),
      );
      const after = await harness.store.getById(row.id);
      assert.equal(after?.latestAction, 'confirm', 'the create was completed first');
      assert.equal(after?.pendingOp, null);
    });
  });
});

describe('C6.3c — a missing etag is observed, never skipped', () => {
  it('patches an event that exists under an id whose etag was never stored', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A definite insert failure leaves `google_event_id` set and the etag
      // null; the insert can still land later (C6.0 — 403 here, but the state
      // is the one an ambiguous attempt reaches).
      harness.calendar.failNext('insert', { status: 403 });
      const created = await book();
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null && row.googleEventId !== null);
      assert.equal(row.googleEventEtag, null);

      // The event is there after all.
      harness.calendar.seedManaged({
        id: row.googleEventId as string,
        start: row.start,
        end: row.end,
        bookingId: row.id,
      });

      await rescheduleBooking(await scopeOf(harness, row.id), {
        start: isoAt(60),
        expectedRevision: 1,
        origin: ORIGIN,
      });

      // Falling through to the fallback insert because the etag is missing
      // duplicates a live event instead of moving it (REVIEW-04).
      const live = harness.calendar.liveEvents();
      assert.equal(live.length, 1, 'the existing event is patched, not duplicated');
      assert.equal(live[0].id, row.googleEventId);
      assert.equal(live[0].start, isoAt(60));
    });
  });
});

describe('C6.0/C6.2 — an unverifiable 2xx completes nothing', () => {
  it('classifies an event body with no id or etag as ambiguous', async () => {
    const calendar = createLiveCalendar({
      accessToken: async () => 'token',
      fetch: async () => ({
        status: 200,
        async json() {
          return {};
        },
        async text() {
          return '{}';
        },
      }),
    });

    const error = await expectThrow(() =>
      calendar.insert({
        calendarId: 'primary',
        id: 'marloabcde',
        start: MONDAY_0900,
        end: isoAt(30),
        summary: 'Intro call',
        bookingId: 'bk_1',
        attemptId: 'att_1',
        sendUpdates: 'none',
      }),
    );
    // A 2xx that identifies no event is malformed, and C6.0 classifies a
    // malformed response as ambiguous — never as an applied mutation, which
    // would finalize `calendar_state='created'` over nothing (REVIEW-05).
    assert.equal(classifyCalendarError(error), 'ambiguous');
  });
});

describe('C6.3c — a same-kind cancel takeover invalidates the predecessor too', () => {
  it('bumps the event version, so a paused delete cannot land after T2′', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book();
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null && row.googleEventId !== null);
      const eventId = row.googleEventId as string;

      // Worker A's own `If-Match`: the etag of the event it is about to delete.
      const held = harness.calendar.eventById(eventId)?.etag;
      assert.ok(held !== undefined);

      // A's delete answers ambiguously, so A stops with `pending_op` retained —
      // the paused predecessor, still holding `held` (C6.0).
      harness.calendar.failNext('delete', { status: 500 });
      const scopeOfRow = await scopeOf(harness, row.id);
      const ambiguous = await expectError(() =>
        cancelBooking(scopeOfRow, { expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(ambiguous.code, 'booking_outcome_unknown');
      assert.equal((await harness.store.getById(row.id))?.pendingOp?.kind, 'cancel');

      await advancePastStaleWindow(harness.clock);

      // B takes the stale cancel over — a **same-kind** takeover — and its
      // delete is definitely refused, so T2′ clears `pending_op` and leaves the
      // booking `confirmed` with its event still on the calendar.
      harness.calendar.failNext('delete', { status: 403 });
      const takeoverScope = await scopeOf(harness, row.id);
      const refused = await expectError(() =>
        cancelBooking(takeoverScope, { expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(refused.code, 'calendar_delete_failed');
      const afterT2Prime = await harness.store.getById(row.id);
      assert.equal(afterT2Prime?.status, 'confirmed');
      assert.equal(afterT2Prime?.calendarState, 'created');

      // The takeover's FIRST Google mutation was the version bump (C6.3c).
      const bumped = harness.calendar.eventById(eventId);
      assert.ok(bumped !== null);
      assert.notEqual(bumped.etag, held, 'the predecessor’s etag is invalidated');

      // A now resumes and issues its delete with the etag it still holds.
      // Without the bump it succeeds, leaving a `confirmed` / `created` row
      // whose calendar event is gone (REVIEW-01).
      const late = await expectThrow(() =>
        harness.calendar.remove({
          calendarId: 'primary',
          eventId,
          ifMatch: held,
          sendUpdates: 'none',
        }),
      );
      assert.equal(classifyCalendarError(late), 'precondition_failed');
      assert.equal(
        harness.calendar.liveEvents().length,
        1,
        'the booking and Google still agree',
      );
    });
  });
});

describe('C5 — a claim is delivered only when its own write committed', () => {
  it('rolls one failed claim back to its savepoint and keeps the other (pg)', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // The FIRST recipient's claim fails inside create T2's send. In Postgres
      // that aborts the whole transaction unless the claim was taken inside a
      // savepoint: the second claim would then fail too, `COMMIT` would answer
      // `ROLLBACK`, and any claim still held in memory would be delivered
      // against a ledger row that no longer exists — a copy `attempts` never
      // counted (REVIEW-01).
      harness.db().failNextStatement('INSERT INTO notification_deliveries');
      const created = await book();

      // The booking is committed either way; only delivery is affected.
      assert.equal(created.envelope.booking.status, 'confirmed');
      assert.equal(created.envelope.delivery.email, 'pending');
      assert.ok(lifecycleLogCount('delivery_claim_failed') >= 1);

      // The other recipient's claim survived the rollback to its savepoint.
      assert.equal(harness.sender.sent.length, 1, 'the second recipient still sends');
      const rows = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
      assert.equal(rows.length, 1, 'exactly the committed claim is in the ledger');
      assert.equal(rows[0].state, 'sent');
      assert.equal(rows[0].attempts, 1, 'and `attempts` still bounds the copies exactly');
      assert.equal(harness.sender.sent[0].recipient, rows[0].recipient);
    });
  });

  it('treats a COMMIT that answers ROLLBACK as a definite failure', async () => {
    const db = createFakeDatabase();
    db.seedOwner({
      id: ownerIdForSlug(DEMO.ownerSlug),
      slug: DEMO.ownerSlug,
      first_name: 'Marlo',
      email: 'demo@example.com',
      calendar_id: 'primary',
    });

    // A statement fails and the caller swallows it — exactly the shape that
    // used to reach `deliver()` with claims the server had already discarded.
    db.failNextStatement('UPSERT-ish');
    const result = await expectThrow(() =>
      inTransaction(db, async (tx) => {
        try {
          await tx.query('UPSERT-ish');
        } catch {
          // swallowed, as a per-item loop would
        }
        return 'value';
      }),
    );
    assert.ok(
      result instanceof TransactionAbortedError,
      `expected TransactionAbortedError, got ${String(result)}`,
    );
    // The tag is the only signal: Postgres answers this COMMIT without error.
    assert.equal(db.sqlLog().includes('COMMIT'), true);
  });
});

async function expectThrow(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

async function onlyBooking(harness: Harness): Promise<BookingRow> {
  const rows: BookingRow[] = [];
  if (harness.mode === 'pg') {
    for (const id of harness.db().tables().bookings.keys()) {
      const row = await harness.store.getById(id);
      if (row !== null) {
        rows.push(row);
      }
    }
  } else {
    rows.push(...(harness.store as MemoryBookingStore).allRows());
  }
  assert.equal(rows.length, 1, `expected exactly one booking, got ${rows.length}`);
  return rows[0];
}

/** The slice of `LifecycleContext` the ownership helpers actually read. */
function opsContext(harness: Harness) {
  return {
    store: harness.store,
    calendar: harness.runtime.calendar,
    calendarId: 'primary',
    clock: harness.clock,
    sendUpdates: 'none' as const,
  };
}

function templateFor(row: BookingRow) {
  return {
    hostFirstName: 'Marlo',
    ownerEmail: 'demo@example.com',
    inviteeName: row.inviteeName,
    inviteeEmail: row.inviteeEmail,
    eventName: 'Intro call',
    start: row.start,
    end: row.end,
    token: row.token,
    origin: ORIGIN,
    bookingId: row.id,
    revision: row.revision,
  };
}
