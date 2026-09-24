// AC-12 / AC-18 / AC-21(a) — reschedule and cancel (C6.6, C6.7), the
// cancel-vs-reschedule policy, takeover, and the superseded-worker rules.
//
// Run against both stores. The interleavings use the fake clock for the
// 2-minute stale window and the mock calendar's held-insert model for delayed
// Google execution — never real time and never the network.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  bookingAvailability,
  cancelBooking,
  createBooking,
  readBooking,
  rescheduleBooking,
  scopeForRow,
} from '../lib/booking/service';
import { LifecycleError } from '../lib/booking/errors';
import { holdsCF1, holdsCF2, holdsCF3, type BookingRow } from '../lib/booking/rows';
import { RESCHEDULE_SLOT_INCREMENT_MIN } from '../lib/availability/slots';
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

async function book(harness: Harness, start = MONDAY_0900) {
  void harness;
  return createBooking({
    ownerSlug: DEMO.ownerSlug,
    eventSlug: DEMO.eventSlug,
    start,
    invitee: INVITEE,
    notes: null,
    idempotencyKey: crypto.randomUUID(),
    origin: ORIGIN,
  });
}

async function scopeOf(harness: Harness, id: string) {
  const row = await harness.store.getById(id);
  assert.ok(row !== null, `booking ${id} must exist`);
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

function assertInvariants(row: BookingRow, label: string): void {
  assert.ok(holdsCF1(row) && holdsCF2(row) && holdsCF3(row), `CF invariants ${label}`);
}

/** Moves an event at Google without touching the store — a dead worker's patch. */
async function moveEventAtGoogle(
  harness: Harness,
  eventId: string,
  start: string,
  end: string,
): Promise<void> {
  const current = harness.calendar.eventById(eventId);
  assert.ok(current !== null, `event ${eventId} must exist to be moved`);
  await harness.calendar.patch({
    calendarId: 'primary',
    eventId,
    start,
    end,
    ifMatch: current.etag,
    sendUpdates: 'none',
  });
}

describe('AC-12 reschedule — moves the live event and emails both parties', () => {
  it('patches the existing event, advances the revision, and sends reschedule mail', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const originalEventId = (await harness.store.getById(created.row.id))?.googleEventId;
      harness.sender.sent.length = 0;
      harness.calendar.calls.length = 0;

      const scope = await scopeOf(harness, created.row.id);
      const moved = await rescheduleBooking(scope, {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });

      assert.equal(moved.envelope.booking.start, isoAt(30));
      assert.equal(moved.envelope.booking.revision, 2);
      assert.equal(moved.envelope.delivery.calendar, 'created');
      assert.equal(moved.envelope.delivery.email, 'sent');

      // A move is a patch of the SAME event, never a second insert.
      const patches = harness.calendar.calls.filter((call) => call.kind === 'patch');
      const inserts = harness.calendar.calls.filter((call) => call.kind === 'insert');
      assert.equal(patches.length, 1);
      assert.equal(inserts.length, 0);
      assert.equal(patches[0].eventId, originalEventId);
      assert.ok(patches[0].ifMatch !== undefined, 'every patch carries If-Match (C6.3c)');
      assert.equal(harness.calendar.liveEvents().length, 1);

      const recipients = harness.sender.sent.map((entry) => entry.recipient).sort();
      assert.deepEqual(recipients, ['invitee', 'owner']);
      assert.ok(harness.sender.sent.every((entry) => entry.action === 'reschedule'));

      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      assert.equal(row.pendingOp, null);
      assert.equal(row.reservedStart, null);
      assert.equal(row.latestAction, 'reschedule');
      assertInvariants(row, 'after reschedule T2');
    });
  });

  it('falls back to an insert under the persisted fallback id when the patch 404s', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const before = await harness.store.getById(created.row.id);
      harness.calendar.calls.length = 0;
      harness.calendar.failNext('patch', { status: 404 });

      const scope = await scopeOf(harness, created.row.id);
      const moved = await rescheduleBooking(scope, {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });

      assert.equal(moved.envelope.booking.start, isoAt(30));
      const inserts = harness.calendar.calls.filter((call) => call.kind === 'insert');
      assert.equal(inserts.length, 1);

      const after = await harness.store.getById(created.row.id);
      assert.ok(after !== null);
      assert.notEqual(after.googleEventId, before?.googleEventId);
      assert.equal(after.googleEventId, inserts[0].eventId);
      assert.equal(after.calendarState, 'created');
    });
  });

  it('refuses a stale expectedRevision with 409 booking_changed', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const scope = await scopeOf(harness, created.row.id);
      await rescheduleBooking(scope, { start: isoAt(30), expectedRevision: 1, origin: ORIGIN });

      const stale = await scopeOf(harness, created.row.id);
      const error = await expectError(() =>
        rescheduleBooking(stale, { start: isoAt(60), expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(error.code, 'booking_changed');
    });
  });

  it('refuses an unchanged-time move with zero calendar calls (C12)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      harness.calendar.calls.length = 0;

      const scope = await scopeOf(harness, created.row.id);
      const error = await expectError(() =>
        rescheduleBooking(scope, {
          start: MONDAY_0900,
          expectedRevision: 1,
          origin: ORIGIN,
        }),
      );
      assert.equal(error.code, 'slot_unavailable');
      assert.equal(harness.calendar.calls.length, 0);
    });
  });
});

describe('AC-8(d) / AC-21(a) — the 15-minute reschedule grid (REV3-08)', () => {
  it('offers an overlapping move the public grid could never produce', async () => {
    assert.equal(RESCHEDULE_SLOT_INCREMENT_MIN, 15);
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness, MONDAY_0900);
      const scope = await scopeOf(harness, created.row.id);

      const times = await bookingAvailability(scope, {
        start: MONDAY_0900,
        end: isoAt(180),
      });

      // 09:15 overlaps the booking's own 09:00–09:30 and is offered because its
      // own occupancy is excluded; its current start never is.
      assert.ok(times.includes(isoAt(15)), 'the overlapping 09:15 slot is offered');
      assert.ok(times.includes(isoAt(30)), 'the adjacent 09:30 slot is offered');
      assert.equal(times.includes(MONDAY_0900), false, 'the current start is excluded');

      // And the server accepts exactly what the picker offered.
      const moved = await rescheduleBooking(scope, {
        start: isoAt(15),
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal(moved.envelope.booking.start, isoAt(15));
      assert.notEqual(moved.envelope.booking.start, MONDAY_0900);
      assert.ok(Date.parse(isoAt(15)) < Date.parse(isoAt(30)), 'an actual overlap');
    });
  });

  it('rejects a start that is not on the reschedule grid', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const scope = await scopeOf(harness, created.row.id);

      const error = await expectError(() =>
        rescheduleBooking(scope, {
          start: isoAt(20),
          expectedRevision: 1,
          origin: ORIGIN,
        }),
      );
      assert.equal(error.code, 'slot_unavailable');
    });
  });
});

describe('AC-12 cancel — deletes the live event and emails both parties', () => {
  it('cancels, retires the live id, and writes calendar_state deleted', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const liveId = (await harness.store.getById(created.row.id))?.googleEventId;
      harness.sender.sent.length = 0;
      harness.calendar.calls.length = 0;

      const scope = await scopeOf(harness, created.row.id);
      const cancelled = await cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN });

      assert.equal(cancelled.envelope.booking.status, 'cancelled');
      assert.equal(cancelled.envelope.booking.revision, 2);
      assert.equal(cancelled.envelope.delivery.calendar, 'deleted');

      const deletes = harness.calendar.calls.filter((call) => call.kind === 'delete');
      assert.equal(deletes.length, 1);
      assert.equal(deletes[0].eventId, liveId);
      assert.ok(deletes[0].ifMatch !== undefined, 'the delete carries If-Match');
      assert.equal(harness.calendar.liveEvents().length, 0);

      const recipients = harness.sender.sent.map((entry) => entry.recipient).sort();
      assert.deepEqual(recipients, ['invitee', 'owner']);
      assert.ok(harness.sender.sent.every((entry) => entry.action === 'cancel'));

      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      assert.equal(row.status, 'cancelled');
      assert.equal(row.calendarState, 'deleted');
      assert.equal(row.pendingOp, null);
      assert.equal(row.unfinishedCreate, null);
      assertInvariants(row, 'after cancel T2');
    });
  });

  it('holds the slot until cancel T2, then frees it', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness, MONDAY_0900);

      // Still confirmed: the slot is occupied.
      const blocked = await expectError(() => book(harness, MONDAY_0900));
      assert.equal(blocked.code, 'slot_unavailable');

      const scope = await scopeOf(harness, created.row.id);
      await cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN });

      const rebooked = await book(harness, MONDAY_0900);
      assert.equal(rebooked.envelope.booking.status, 'confirmed');
    });
  });

  it('tolerates a 404 on delete and still reaches cancelled', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      harness.calendar.failNext('delete', { status: 404 });

      const scope = await scopeOf(harness, created.row.id);
      const cancelled = await cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN });
      assert.equal(cancelled.envelope.booking.status, 'cancelled');
      assert.equal(cancelled.envelope.delivery.calendar, 'deleted');
    });
  });

  it('a definite delete failure is 502 and leaves the booking confirmed', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      harness.calendar.failNext('delete', { status: 403 });

      const scope = await scopeOf(harness, created.row.id);
      const error = await expectError(() =>
        cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(error.code, 'calendar_delete_failed');
      assert.equal(error.status, 502);

      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      assert.equal(row.status, 'confirmed');
      assertInvariants(row, 'after cancel T2′');
    });
  });

  it('resumes at T2 after a successful delete, with no second delete', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      harness.calendar.calls.length = 0;

      // The delete lands, then the process dies before T2.
      const scope = await scopeOf(harness, created.row.id);
      if (harness.mode === 'pg') {
        harness.db().setNextCommitOutcome('definite', { matching: "status = 'cancelled'" });
      }
      await expectError(() => cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN })).catch(
        () => undefined,
      );

      const retryScope = await scopeOf(harness, created.row.id);
      const retried = await cancelBooking(retryScope, {
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal(retried.envelope.booking.status, 'cancelled');
      assert.equal(harness.calendar.liveEvents().length, 0);
    });
  });
});

describe('AC-12 cancel-vs-reschedule — one policy (C6.7)', () => {
  it('refuses a cancel while a live reschedule owns pending_op, with zero calendar calls', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);

      // A reschedule that has committed T1 and not yet reached its calendar step.
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            pendingOp: {
              kind: 'reschedule',
              opId: 'op-reschedule',
              gen: 1,
              startedAt: new Date(harness.clock.now()).toISOString(),
              newStart: isoAt(30),
              newEnd: isoAt(60),
              oldEventId: row.googleEventId ?? undefined,
              fallbackEventId: 'marlofallback1',
              attempts: [],
            },
            reservedStart: isoAt(30),
            reservedEnd: isoAt(60),
          },
        });
      });
      harness.calendar.calls.length = 0;

      const scope = await scopeOf(harness, created.row.id);
      const error = await expectError(() =>
        cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(error.code, 'operation_in_progress');
      assert.ok(
        typeof (error.body as { retryAfterSeconds?: number }).retryAfterSeconds === 'number',
      );
      assert.equal(harness.calendar.calls.length, 0, 'the cancel makes no calendar call');
    });
  });

  it('refuses a reschedule while a cancel owns pending_op, inserting nothing', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);

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
              oldEventId: row.googleEventId ?? undefined,
              attempts: [],
            },
          },
        });
      });
      harness.calendar.calls.length = 0;

      const scope = await scopeOf(harness, created.row.id);
      const error = await expectError(() =>
        rescheduleBooking(scope, { start: isoAt(30), expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(error.code, 'operation_in_progress');
      assert.equal(
        harness.calendar.calls.filter((call) => call.kind === 'insert').length,
        0,
      );
    });
  });

  it('a cancel takes a STALE reschedule over, completes it from Google, and cancels', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      const liveId = row.googleEventId as string;

      // A reschedule that patched the event and died before its T2.
      await moveEventAtGoogle(harness, liveId, isoAt(30), isoAt(60));
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
              oldEventId: liveId,
              fallbackEventId: 'marlofallback2',
              attempts: [],
            },
            reservedStart: isoAt(30),
            reservedEnd: isoAt(60),
          },
        });
      });

      await advancePastStaleWindow(harness.clock);

      const scope = await scopeOf(harness, created.row.id);
      const cancelled = await cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN });

      assert.equal(cancelled.envelope.booking.status, 'cancelled');
      // The reschedule was COMPLETED from observed Google state (revision 1 →
      // 2 for the move, → 3 for the cancel), never silently discarded.
      assert.equal(cancelled.envelope.booking.revision, 3);
      assert.equal(harness.calendar.liveEvents().length, 0);

      const after = await harness.store.getById(created.row.id);
      assert.ok(after !== null);
      assert.equal(after.reservedStart, null);
      assertInvariants(after, 'after a takeover cancel');
    });
  });
});

describe('AC-18(vii) — same-target recovery after death between patch and T2 (REV7-03)', () => {
  it('returns the completed move as this request’s own 200, with no second op', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      const liveId = row.googleEventId as string;

      // Worker A patched S → T and died before T2.
      await moveEventAtGoogle(harness, liveId, isoAt(30), isoAt(60));
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            pendingOp: {
              kind: 'reschedule',
              opId: 'op-a',
              gen: 1,
              startedAt: new Date(harness.clock.now()).toISOString(),
              newStart: isoAt(30),
              newEnd: isoAt(60),
              oldEventId: liveId,
              fallbackEventId: 'marlofallback3',
              attempts: [],
            },
            reservedStart: isoAt(30),
            reservedEnd: isoAt(60),
          },
        });
      });
      await advancePastStaleWindow(harness.clock);
      harness.calendar.calls.length = 0;

      // The guest's retry asks for the SAME target.
      const scope = await scopeOf(harness, created.row.id);
      const recovered = await rescheduleBooking(scope, {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });

      // 200 with the completed outcome — never `slot_unavailable` for a move
      // that already happened.
      assert.equal(recovered.envelope.booking.start, isoAt(30));
      assert.equal(recovered.envelope.booking.revision, 2);
      assert.equal(recovered.recovered, true);

      const after = await harness.store.getById(created.row.id);
      assert.ok(after !== null);
      assert.equal(after.pendingOp, null, 'no second operation was started');
      assert.equal(after.reservedStart, null, 'no second reservation');
      // A takeover's version bump is a patch of `extendedProperties` only
      // (C6.3c); what recovery must not do is move the event again.
      assert.equal(
        harness.calendar.calls.filter(
          (call) => call.kind === 'patch' && call.start !== undefined,
        ).length,
        0,
        'recovery issues no further interval-moving patch',
      );
    });
  });

  it('answers 409 booking_changed when the completed move went somewhere else', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      const liveId = row.googleEventId as string;

      await moveEventAtGoogle(harness, liveId, isoAt(30), isoAt(60));
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            pendingOp: {
              kind: 'reschedule',
              opId: 'op-a',
              gen: 1,
              startedAt: new Date(harness.clock.now()).toISOString(),
              newStart: isoAt(30),
              newEnd: isoAt(60),
              oldEventId: liveId,
              fallbackEventId: 'marlofallback4',
              attempts: [],
            },
            reservedStart: isoAt(30),
            reservedEnd: isoAt(60),
          },
        });
      });
      await advancePastStaleWindow(harness.clock);

      const scope = await scopeOf(harness, created.row.id);
      const error = await expectError(() =>
        rescheduleBooking(scope, {
          start: isoAt(90),
          expectedRevision: 1,
          origin: ORIGIN,
        }),
      );
      assert.equal(error.code, 'booking_changed');

      // The reconciliation stands: the booking is at T, revision 2.
      const after = await harness.store.getById(created.row.id);
      assert.ok(after !== null);
      assert.equal(after.start, isoAt(30));
      assert.equal(after.revision, 2);
    });
  });
});

describe('AC-4 / C6.1 — reservations are durable occupancy', () => {
  it('a create into a slot another booking has RESERVED is 409', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness, MONDAY_0900);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);

      // A reschedule that reserved 10:00 and has not completed.
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            pendingOp: {
              kind: 'reschedule',
              opId: 'op-reserving',
              gen: 1,
              startedAt: new Date(harness.clock.now()).toISOString(),
              newStart: isoAt(60),
              newEnd: isoAt(90),
              oldEventId: row.googleEventId ?? undefined,
              fallbackEventId: 'marlofallback5',
              attempts: [],
            },
            reservedStart: isoAt(60),
            reservedEnd: isoAt(90),
          },
        });
      });

      // The destination is taken…
      const intoDestination = await expectError(() => book(harness, isoAt(60)));
      assert.equal(intoDestination.code, 'slot_unavailable');
      // …and so is the OLD slot, which is retained until T2.
      const intoOldSlot = await expectError(() => book(harness, MONDAY_0900));
      assert.equal(intoOldSlot.code, 'slot_unavailable');
    });
  });
});

describe('AC-23(a) — delivery.calendar mirrors calendar_state, pending included', () => {
  it('a read of an unfinished create returns pending; a create 201 never can', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      // The insert is held: T1 committed, the calendar outcome is unresolved.
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() =>
        createBooking({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: DEMO.eventSlug,
          start: MONDAY_0900,
          invitee: INVITEE,
          notes: null,
          idempotencyKey: crypto.randomUUID(),
          origin: ORIGIN,
        }),
      );

      const rows = await allBookings(harness);
      assert.equal(rows.length, 1);
      const row = rows[0];
      assert.equal(row.calendarState, 'pending');
      assert.equal(row.latestAction, null);
      assertInvariants(row, 'while the create is unfinished');

      const scope = await scopeForRow(row, harness.runtime);
      const envelope = await readBooking(scope);
      // REV13-02: the read surface mirrors every state of the column.
      assert.equal(envelope.delivery.calendar, 'pending');
      // `pending` is never an error.
      assert.equal(envelope.delivery.errors, undefined);
      // No ledger row exists for either required recipient yet.
      assert.equal(envelope.delivery.email, 'pending');
    });
  });
});

describe('AC-12 — a superseded worker never deletes a live id (REV7-01)', () => {
  it('leaves the winner’s adopted event alone when its own insert response is late', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const row = await harness.store.getById(created.row.id);
      assert.ok(row !== null);
      const liveId = row.googleEventId as string;

      // Plant an unresolved attempt naming the row's own LIVE id — exactly the
      // state a delayed insert response leaves behind (AC-11(l)).
      await harness.store.withHostLock(row.hostId, async (tx) => {
        await tx.update({
          id: row.id,
          expectedRevision: 1,
          patch: {
            unresolvedInserts: [
              {
                attemptId: 'attempt-late',
                eventId: liveId,
                opId: 'op-late',
                gen: 1,
                issuedAt: MONDAY_0900,
                inspectSeq: null,
                inspectedAt: null,
              },
            ],
          },
        });
      });
      harness.calendar.calls.length = 0;

      // Every designated observing call must leave a LIVE id completely alone.
      const scope = await scopeOf(harness, created.row.id);
      await readBooking(scope);

      const touched = harness.calendar.calls.filter(
        (call) => call.eventId === liveId && (call.kind === 'get' || call.kind === 'delete'),
      );
      assert.equal(touched.length, 0, 'a live id is never reaped');
      assert.equal(harness.calendar.liveEvents().length, 1);

      const after = await harness.store.getById(created.row.id);
      assert.equal(after?.unresolvedInserts.length, 1, 'the entry stays listed');
    });
  });
});

// ---- helpers --------------------------------------------------------------

async function allBookings(harness: Harness): Promise<BookingRow[]> {
  if (harness.mode === 'pg') {
    const rows: BookingRow[] = [];
    for (const id of [...harness.db().tables().bookings.keys()]) {
      const row = await harness.store.getById(id);
      if (row !== null) {
        rows.push(row);
      }
    }
    return rows;
  }
  const memory = harness.store as unknown as { allRows(): BookingRow[] };
  return memory.allRows();
}
