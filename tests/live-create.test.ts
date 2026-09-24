// AC-11 / AC-19 / AC-4(e) / AC-10 — the two-phase create (C6.4).
//
// Every case runs against **both** stores through the shared harness, because
// the whole point of the `BookingStore` seam is that C6 is written once and the
// two implementations cannot drift (AC-3).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createBooking, resolveScope } from '../lib/booking/service';
import { createDurableBooking } from '../lib/booking/create';
import type { MemoryBookingStore } from '../lib/booking/memory-store';
import { createFingerprint } from '../lib/booking/fingerprint';
import { LifecycleError } from '../lib/booking/errors';
import { holdsCF1, holdsCF2, holdsCF3, type BookingRow } from '../lib/booking/rows';
import {
  advancePastStaleWindow,
  bothStores,
  DEMO,
  isoAt,
  MONDAY_0900,
  withHarness,
  type Harness,
} from './support/harness';

const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };
const ORIGIN = 'https://marlo.test';

/** The service-level create every case drives, with a fresh key by default. */
async function book(
  harness: Harness,
  overrides: {
    start?: string;
    key?: string;
    invitee?: { name: string; email: string };
  } = {},
) {
  void harness;
  return createBooking({
    ownerSlug: DEMO.ownerSlug,
    eventSlug: DEMO.eventSlug,
    start: overrides.start ?? MONDAY_0900,
    invitee: overrides.invitee ?? INVITEE,
    notes: null,
    idempotencyKey: overrides.key ?? crypto.randomUUID(),
    origin: ORIGIN,
  });
}

async function expectError(fn: () => Promise<unknown>): Promise<LifecycleError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(
      error instanceof LifecycleError,
      `expected a LifecycleError, got ${String(error)}`,
    );
    return error;
  }
  throw new Error('expected the call to reject');
}

function assertInvariants(row: BookingRow, label: string): void {
  assert.ok(holdsCF1(row), `CF-1 violated ${label}`);
  assert.ok(holdsCF2(row), `CF-2 violated ${label}`);
  assert.ok(holdsCF3(row), `CF-3 violated ${label}`);
}

describe('AC-11 create — the happy path commits before the calendar step', () => {
  it('runs L0 → R0 → T1 → insert → T2 → email and returns the C3 envelope', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug, firstName: 'Marlo' });

      const outcome = await book(harness);

      assert.equal(outcome.replayed, false);
      assert.equal(outcome.envelope.booking.status, 'confirmed');
      assert.equal(outcome.envelope.booking.revision, 1);
      assert.equal(outcome.envelope.delivery.calendar, 'created');
      assert.equal(outcome.envelope.delivery.email, 'sent');
      // C11: the id and the token are two different things, always.
      assert.notEqual(outcome.envelope.booking.id, outcome.envelope.booking.token);
      assert.ok(outcome.envelope.booking.token.length >= 32);

      const row = await harness.store.getById(outcome.row.id);
      assert.ok(row !== null);
      assert.equal(row.pendingOp, null);
      assert.equal(row.latestAction, 'confirm');
      assert.equal(row.calendarState, 'created');
      assertInvariants(row, 'after a successful create');

      // Exactly one event, carrying both extended properties (REV6-01).
      const events = harness.calendar.liveEvents();
      assert.equal(events.length, 1);
      assert.equal(events[0].marloBookingId, row.id);
      assert.ok(
        typeof events[0].marloAttemptId === 'string' && events[0].marloAttemptId !== '',
      );

      // Both required recipients, exactly once each (C4).
      const recipients = harness.sender.sent.map((entry) => entry.recipient).sort();
      assert.deepEqual(recipients, ['invitee', 'owner']);
      assert.ok(harness.sender.sent.every((entry) => entry.action === 'confirm'));
    });
  });

  it('holds the slot from T1, so an overlapping create is 409 slot_unavailable', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      await book(harness, { start: MONDAY_0900 });

      // Different start, overlapping interval — the C6.1 union, not equality.
      const error = await expectError(() => book(harness, { start: isoAt(15) }));
      assert.equal(error.code, 'slot_unavailable');
      assert.equal(error.status, 409);

      // A non-overlapping slot for the same host still books.
      const later = await book(harness, { start: isoAt(60) });
      assert.equal(later.envelope.booking.status, 'confirmed');
    });
  });
});

describe('AC-19 create idempotency (C9)', () => {
  it('replays the same key to the same booking with zero Google calls', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();

      const first = await book(harness, { key });
      const callsAfterFirst = harness.calendar.calls.length;
      const sentAfterFirst = harness.sender.sent.length;

      const replay = await book(harness, { key });

      assert.equal(replay.replayed, true);
      assert.equal(replay.envelope.booking.id, first.envelope.booking.id);
      assert.equal(replay.envelope.booking.token, first.envelope.booking.token);
      // REV7-02 / REV11-02: a replay of a finalized row touches Google not at all.
      assert.equal(harness.calendar.calls.length, callsAfterFirst);
      assert.equal(harness.sender.sent.length, sentAfterFirst);
    });
  });

  it('replays during a total Calendar outage, because L0 precedes R0 (REV7-02)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();
      const first = await book(harness, { key });

      // Every read of the host's calendar now throws; a replay must not care.
      harness.calendar.failListWith({ throw: new Error('calendar outage') });
      harness.calendar.calls.length = 0;

      const replay = await book(harness, { key });

      assert.equal(replay.envelope.booking.id, first.envelope.booking.id);
      assert.equal(harness.calendar.calls.length, 0, 'a replay issues no Google call');
    });
  });

  it('answers 422 when the same key carries a different payload', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();
      await book(harness, { key, start: MONDAY_0900 });

      const error = await expectError(() =>
        book(harness, { key, start: isoAt(60) }),
      );
      assert.equal(error.code, 'idempotency_key_reused');
      assert.equal(error.status, 422);
    });
  });

  it('compares the immutable fingerprint, never the mutable start (REV3-05)', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();
      const created = await book(harness, { key, start: MONDAY_0900 });

      // Move the booking, then replay the ORIGINAL payload.
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            start: isoAt(30),
            end: isoAt(60),
            latestAction: 'reschedule',
            bumpRevision: true,
          },
        });
      });

      const replay = await book(harness, { key, start: MONDAY_0900 });
      assert.equal(replay.envelope.booking.id, created.row.id);
      assert.equal(replay.envelope.booking.start, isoAt(30));
      assert.equal(replay.envelope.booking.revision, 2);

      // The lookup selects `create_fingerprint`; it never compares `start`.
      const lookups = harness
        .db()
        .statements.filter((entry) => entry.sql.includes('idempotency_key = $2'));
      assert.ok(lookups.length > 0);
      assert.ok(
        lookups.every((entry) => !entry.sql.includes('"start" = ')),
        'the C9 lookup must not compare bookings.start',
      );
    });
  });

  it('requires the header on a one_on_one create', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const error = await expectError(() =>
        createBooking({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: DEMO.eventSlug,
          start: MONDAY_0900,
          invitee: INVITEE,
          notes: null,
          idempotencyKey: null,
          origin: ORIGIN,
        }),
      );
      assert.equal(error.code, 'idempotency_key_required');
      assert.equal(error.status, 400);
    });
  });
});

describe('AC-4(e) / AC-11(q) — a terminal rejection is durably fenced (REV8-01)', () => {
  it('writes the fence in the rejecting T1 and repeats it with zero Google calls', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      // Someone else takes the slot first.
      await book(harness, { start: MONDAY_0900 });

      const key = crypto.randomUUID();
      const rejected = await expectError(() => book(harness, { key, start: MONDAY_0900 }));
      assert.equal(rejected.code, 'slot_unavailable');

      const fences = harness.db().rejections();
      assert.equal(fences.length, 1);
      assert.equal(fences[0].idempotency_key, key);
      assert.equal(fences[0].reason, 'slot_unavailable');

      // The fence is consulted in L0, so the repeat is free of Google traffic.
      harness.calendar.calls.length = 0;
      const repeated = await expectError(() => book(harness, { key, start: MONDAY_0900 }));
      assert.equal(repeated.code, 'slot_unavailable');
      assert.equal(harness.calendar.calls.length, 0);
    });
  });

  it('fences (key, fingerprint) rather than the key, so another slot still books', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      await book(harness, { start: MONDAY_0900 });

      const key = crypto.randomUUID();
      const rejected = await expectError(() => book(harness, { key, start: MONDAY_0900 }));
      assert.equal(rejected.code, 'slot_unavailable');

      // The SAME key at a free slot is a different fingerprint — and books.
      const elsewhere = await book(harness, { key, start: isoAt(120) });
      assert.equal(elsewhere.envelope.booking.status, 'confirmed');
      assert.equal(elsewhere.envelope.booking.start, isoAt(120));
    });
  });

  it('fences an attempt that was paused before its own T1 (the REV8-01 interleaving)', async () => {
    await withHarness('pg', async (harness) => {
      const { ownerId, hostId, eventTypeId } = await harness.seedOwner({
        slug: DEMO.ownerSlug,
      });
      const scope = await resolveScope(DEMO.ownerSlug, DEMO.eventSlug);
      const key = crypto.randomUUID();

      // Request A passes L0 and R0 and is held *before* its T1.
      let releaseA: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseA = resolve;
      });
      const requestA = createDurableBooking(
        {
          ctx: scope.ctx,
          meta: scope.meta,
          notify: async () => {},
          hooks: { afterR0: () => gate },
        },
        {
          ownerId,
          ownerSlug: DEMO.ownerSlug,
          ownerEmail: 'demo@example.com',
          hostFirstName: 'Marlo',
          hostId,
          eventTypeId,
          eventSlug: DEMO.eventSlug,
          eventName: 'Intro call',
          durationMinutes: 30,
          start: MONDAY_0900,
          invitee: INVITEE,
          notes: null,
          metadata: {},
          idempotencyKey: key,
          timeZone: 'UTC',
        },
      );
      // Let A reach its pause.
      await Promise.resolve();
      await Promise.resolve();

      // Meanwhile another guest books the slot, and the client's own retry of
      // the same key is rejected — writing the fence.
      await book(harness, { start: MONDAY_0900 });
      const retry = await expectError(() => book(harness, { key, start: MONDAY_0900 }));
      assert.equal(retry.code, 'slot_unavailable');

      const bookingsBefore = harness.db().tables().bookings.size;

      // A resumes: its mandatory second lookup finds the fence.
      releaseA();
      const resumed = await expectError(() => requestA);
      assert.equal(resumed.code, 'slot_unavailable');
      assert.equal(
        harness.db().tables().bookings.size,
        bookingsBefore,
        'the fenced request must insert no row',
      );
      assert.equal(
        harness.db().rejections().length,
        1,
        'exactly one fence for this (key, fingerprint)',
      );
    });
  });
});

describe('AC-11 create — calendar outcomes (C6.0)', () => {
  it('a definite insert failure still finalizes the booking (T2′, REV3-03)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.calendar.failNext('insert', { status: 403 });

      const outcome = await book(harness);

      // 201, not a 4xx: the row is committed, only the calendar failed.
      assert.equal(outcome.envelope.booking.status, 'confirmed');
      assert.equal(outcome.envelope.delivery.calendar, 'failed');
      assert.equal(outcome.envelope.delivery.errors?.calendar, 'calendar_insert_failed');
      assert.equal(outcome.envelope.delivery.email, 'sent');

      const row = await harness.store.getById(outcome.row.id);
      assert.ok(row !== null);
      // Exactly the persisted state AC-10(d) names.
      assert.equal(row.revision, 1);
      assert.equal(row.latestAction, 'confirm');
      assert.equal(row.calendarState, 'failed');
      assert.equal(row.pendingOp, null);
      assertInvariants(row, 'after create T2′');
    });
  });

  it('an ambiguous insert retains pending_op and answers 503 (429 included)', async () => {
    for (const status of [429, 503]) {
      await bothStores(async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        harness.calendar.failNext('insert', { status });

        const error = await expectError(() => book(harness));
        assert.equal(error.code, 'booking_outcome_unknown', `status ${status}`);
        assert.equal(error.status, 503);

        const row = await findOnlyBooking(harness);
        // C6.0: the attempt stays unresolved and the op is retained, because
        // the insert may still execute.
        assert.equal(row.calendarState, 'pending');
        assert.equal(row.latestAction, null);
        assert.ok(row.pendingOp !== null);
        assert.equal(row.pendingOp.kind, 'create');
        assert.deepEqual(
          row.pendingOp.attempts.map((attempt) => attempt.outcome),
          ['unresolved'],
        );
        assertInvariants(row, `after an ambiguous ${status}`);
        assert.equal(harness.sender.sent.length, 0, 'nothing is sent');
      });
    }
  });

  it('a replay resumes an ambiguous create with exactly one further insert', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();

      harness.calendar.failNext('insert', { status: 503 });
      await expectError(() => book(harness, { key }));

      const before = await findOnlyBooking(harness);
      const intendedId = before.pendingOp?.eventId;
      assert.ok(typeof intendedId === 'string');

      // The owner is still live: a replay inside the window must not take over.
      const busy = await expectError(() => book(harness, { key }));
      assert.equal(busy.code, 'operation_in_progress');

      await advancePastStaleWindow(harness.clock);
      const resumed = await book(harness, { key });

      assert.equal(resumed.envelope.delivery.calendar, 'created');
      const after = await harness.store.getById(before.id);
      assert.ok(after !== null);
      assert.equal(after.pendingOp, null);
      // The SAME intended id — never a second, orphaned event.
      assert.equal(after.googleEventId, intendedId);
      const inserts = harness.calendar.calls.filter((call) => call.kind === 'insert');
      assert.equal(inserts.length, 2, 'the first attempt plus exactly one retry');
      assert.ok(inserts.every((call) => call.eventId === intendedId));
      assert.equal(harness.calendar.liveEvents().length, 1);
    });
  });

  it('retains an unresolved attempt across a SUCCESSFUL T2 (REV5-01)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();

      // Attempt 1 is captured and held: the caller sees a timeout while the
      // request is still in flight at Google.
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() => book(harness, { key }));

      await advancePastStaleWindow(harness.clock);
      const resumed = await book(harness, { key });
      assert.equal(resumed.envelope.delivery.calendar, 'created');

      const row = await harness.store.getById(resumed.row.id);
      assert.ok(row !== null);
      assert.equal(row.calendarState, 'created');
      assert.equal(row.pendingOp, null);
      // Observation completes OPS, never attempts: attempt 1 is still listed,
      // under the row's own live id.
      assert.equal(row.unresolvedInserts.length, 1);
      assert.equal(row.unresolvedInserts[0].eventId, row.googleEventId);
    });
  });
});

describe('AC-11 create — unknown commit outcomes (C6.5)', () => {
  it('a definite T1 commit failure is 500 with zero calendar mutations', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.db().setNextCommitOutcome('definite', { matching: 'INSERT INTO bookings' });

      const error = await expectError(() => book(harness));
      assert.equal(error.code, 'booking_failed');
      assert.equal(error.status, 500);
      assert.equal(
        harness.calendar.calls.filter((call) => call.kind === 'insert').length,
        0,
      );
      assert.equal(harness.db().tables().bookings.size, 0);
    });
  });

  it('an unknown T1 commit that COMMITTED continues on a fresh connection', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness
        .db()
        .setNextCommitOutcome('unknown-committed', { matching: 'INSERT INTO bookings' });

      const outcome = await book(harness);

      assert.equal(outcome.envelope.booking.status, 'confirmed');
      assert.equal(outcome.envelope.delivery.calendar, 'created');

      // C6.5, in the exact order AC-11(b) fixes: the reconciler's key lookup is
      // preceded — on its OWN connection — by `SET LOCAL lock_timeout` and the
      // advisory lock, and that connection is not the one whose commit was lost.
      const log = harness.db().statements;
      const indexed = log.map((entry, index) => ({ entry, index }));
      const lostCommit = indexed.find(
        ({ entry }) =>
          entry.sql.trim() === 'COMMIT' &&
          log
            .slice(0, indexed.findIndex((row) => row.entry === entry))
            .some((prior) => prior.sql.includes('INSERT INTO bookings')),
      );
      assert.ok(lostCommit !== undefined, 'T1 issued a COMMIT');

      const reconcileLookup = indexed
        .filter(
          ({ entry, index }) =>
            entry.sql.includes('idempotency_key = $2') && index > lostCommit.index,
        )
        .at(0);
      assert.ok(reconcileLookup !== undefined, 'the reconciler re-read the key');

      const onSameConnectionBefore = indexed.filter(
        ({ entry, index }) =>
          entry.connectionId === reconcileLookup.entry.connectionId &&
          index < reconcileLookup.index,
      );
      assert.ok(
        onSameConnectionBefore.some(({ entry }) =>
          entry.sql.includes('pg_advisory_xact_lock'),
        ),
        'the lock is reacquired before the read',
      );
      assert.ok(
        onSameConnectionBefore.some(({ entry }) => entry.sql.includes('lock_timeout')),
        'the reacquisition is bounded by lock_timeout',
      );
      assert.notEqual(
        reconcileLookup.entry.connectionId,
        lostCommit.entry.connectionId,
        'the reconciler must use a FRESH connection',
      );
    });
  });

  it('an unknown T1 commit that ROLLED BACK is 500 and touches no calendar', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness
        .db()
        .setNextCommitOutcome('unknown-rolled-back', { matching: 'INSERT INTO bookings' });

      const error = await expectError(() => book(harness));
      assert.equal(error.code, 'booking_failed');
      assert.equal(
        harness.calendar.calls.filter((call) => call.kind === 'insert').length,
        0,
      );
    });
  });

  it('a delayed commit blocks the reconciler on the lock, then answers 201', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      // The response is lost now; the transaction stays open, holding the lock,
      // and commits 40 ms later. No compensation may happen in that window.
      harness.db().setNextCommitOutcome(
        { unknown: true, resolveAfterMs: 40, as: 'commit' },
        { matching: 'INSERT INTO bookings' },
      );

      const outcome = await book(harness);

      assert.equal(outcome.envelope.booking.status, 'confirmed');
      assert.ok(
        harness.db().locks.waitLog.length > 0,
        'the reconciler must have blocked on the advisory lock',
      );
    });
  });
});

describe('AC-11 create — CF invariants hold on every committed row (C6.4a)', () => {
  it('never parks a row with no owner and an unfinished creation', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A spread of outcomes, each leaving a differently-shaped row.
      harness.calendar.failNext('insert', { status: 403 });
      await book(harness, { start: MONDAY_0900 });

      harness.calendar.failNext('insert', { status: 503 });
      await expectError(() => book(harness, { start: isoAt(60) }));

      await book(harness, { start: isoAt(120) });

      for (const row of await allBookings(harness)) {
        assertInvariants(row, `row ${row.id}`);
        if (row.pendingOp === null) {
          assert.notEqual(
            row.latestAction,
            null,
            'CF-2: an ownerless row always has a finalized creation',
          );
        }
      }
    });
  });
});

describe('C9 replay predicate — nullness, never a particular value (REV15-02)', () => {
  it('replays a rescheduled and a cancelled booking as 201 with current state', async () => {
    for (const later of ['reschedule', 'cancel'] as const) {
      await bothStores(async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        const key = crypto.randomUUID();
        const created = await book(harness, { key });

        const row = await harness.store.getById(created.row.id);
        assert.ok(row !== null);
        await harness.store.withHostLock(row.hostId, async (tx) => {
          await tx.update({
            id: row.id,
            expectedRevision: 1,
            patch:
              later === 'reschedule'
                ? {
                    start: isoAt(30),
                    end: isoAt(60),
                    latestAction: 'reschedule',
                    bumpRevision: true,
                  }
                : {
                    status: 'cancelled',
                    latestAction: 'cancel',
                    calendarState: 'deleted',
                    bumpRevision: true,
                  },
          });
        });

        const replay = await book(harness, { key });
        assert.equal(replay.envelope.booking.id, created.row.id);
        assert.equal(replay.envelope.booking.revision, 2);
        if (later === 'cancel') {
          assert.equal(replay.envelope.booking.status, 'cancelled');
          assert.equal(replay.envelope.delivery.calendar, 'deleted');
        } else {
          assert.equal(replay.envelope.booking.start, isoAt(30));
        }
      });
    }
  });

  it('answers a non-terminal 409 while the creation is unfinished (REV14-01)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const key = crypto.randomUUID();
      harness.calendar.failNext('insert', { status: 503 });
      await expectError(() => book(harness, { key }));

      const row = await findOnlyBooking(harness);
      // Re-shape the row into exactly the C6.7 state: a cancel replaced the
      // create without completing it.
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            pendingOp: {
              kind: 'cancel',
              opId: 'op-cancel',
              gen: 1,
              startedAt: new Date(harness.clock.now()).toISOString(),
              attempts: [],
            },
            unfinishedCreate: {
              opId: row.pendingOp?.opId ?? 'op-create',
              gen: 1,
              eventId: row.pendingOp?.eventId ?? 'marlox',
              startedAt: row.pendingOp?.startedAt ?? MONDAY_0900,
              attempts: row.pendingOp?.attempts ?? [],
            },
          },
        });
      });

      harness.calendar.calls.length = 0;
      const error = await expectError(() => book(harness, { key }));

      // Never 201 (its envelope could only read `calendar: 'pending'`, which C3
      // forbids), never `operation_superseded`, never terminal.
      assert.equal(error.code, 'operation_in_progress');
      assert.equal(error.status, 409);
      assert.equal(harness.calendar.calls.length, 0, 'zero Google calls');

      const after = await harness.store.getById(row.id);
      assert.ok(after !== null);
      assert.equal(after.latestAction, null);
      assert.equal(after.calendarState, 'pending');
      assertInvariants(after, 'while a cancel holds an unfinished create');
    });
  });
});

describe('C6.4 L0 — the fingerprint is stable across stores', () => {
  it('derives the same fingerprint from the canonical payload', () => {
    const a = createFingerprint({
      eventTypeId: DEMO.eventTypeId,
      start: MONDAY_0900,
      inviteeEmail: 'Ada@Example.com ',
    });
    const b = createFingerprint({
      eventTypeId: DEMO.eventTypeId,
      start: MONDAY_0900,
      inviteeEmail: 'ada@example.com',
    });
    assert.equal(a, b, 'the invitee email is lower-cased and trimmed');

    const different = createFingerprint({
      eventTypeId: DEMO.eventTypeId,
      start: isoAt(30),
      inviteeEmail: 'ada@example.com',
    });
    assert.notEqual(a, different);
  });
});

// ---- helpers --------------------------------------------------------------

async function allBookings(harness: Harness): Promise<BookingRow[]> {
  if (harness.mode === 'pg') {
    const ids = [...harness.db().tables().bookings.keys()];
    const rows: BookingRow[] = [];
    for (const id of ids) {
      const row = await harness.store.getById(id);
      if (row !== null) {
        rows.push(row);
      }
    }
    return rows;
  }
  return (harness.store as MemoryBookingStore).allRows();
}

async function findOnlyBooking(harness: Harness): Promise<BookingRow> {
  const rows = await allBookings(harness);
  assert.equal(rows.length, 1, `expected exactly one booking, got ${rows.length}`);
  return rows[0];
}
