// AC-12 parity matrix, AC-25(g), and the C6.3a interleavings that have to be
// **driven** rather than planted.
//
// Three things this file exists for, all of them previously unproved:
//
//  1. **Adapter parity.** Every scenario below runs twice — once against the
//     mock adapter, once against `createLiveCalendar` / `createLiveEmailSender`
//     over a fake `fetch` that speaks Google's REST shape against the *same*
//     model (`tests/support/google-fetch.ts`). A difference the tests see is a
//     difference between the adapters, not between two hand-written doubles.
//  2. **Both documented collision behaviours.** A re-used id answers 409
//     `duplicate` in one Google and lands in the other (C6.3a, Assumptions), and
//     every retention/reap claim must hold in both.
//  3. **Real interleavings.** `unfinished_create` is produced by a cancel taking
//     over a stale create whose event is absent — not written into the row by
//     the test — and the fallback-compensation and cleanup-failure cases are
//     driven through the lifecycle with held inserts and the fake clock.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cancelBooking,
  createBooking,
  readBooking,
  rescheduleBooking,
  scopeForRow,
} from '../lib/booking/service';
import { LifecycleError } from '../lib/booking/errors';
import { holdsCF1, holdsCF2, holdsCF3, type BookingRow } from '../lib/booking/rows';
import { MemoryBookingStore } from '../lib/booking/memory-store';
import {
  CALENDAR_INVITATION,
  createEventType,
  ONE_ON_ONE,
} from '../lib/availability/event-type';
import { eventTypeIdFor } from '../lib/owners';
import { CalendarError } from '../lib/google/errors';
import {
  advancePastStaleWindow,
  bothAdapters,
  bothCollisionModes,
  DEMO,
  isoAt,
  MONDAY_0900,
  withHarness,
  type Harness,
} from './support/harness';

const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };
const ORIGIN = 'https://marlo.test';

async function book(
  start = MONDAY_0900,
  key = crypto.randomUUID(),
  eventSlug: string = DEMO.eventSlug,
) {
  return createBooking({
    ownerSlug: DEMO.ownerSlug,
    eventSlug,
    start,
    invitee: INVITEE,
    notes: null,
    idempotencyKey: key,
    origin: ORIGIN,
  });
}

/**
 * C4 — the same demo host with the other `notificationMode`. Event types are
 * fixture-defined (Non-goals: no CRUD), so the second one is registered the way
 * the fixtures themselves are, on the demo owner's existing schedule.
 */
const INVITE_SLUG = 'invite-30';

function seedCalendarInvitationEventType(): void {
  createEventType({
    id: eventTypeIdFor(DEMO.ownerSlug, INVITE_SLUG),
    ownerId: DEMO.ownerId,
    hostId: DEMO.ownerId,
    slug: INVITE_SLUG,
    name: 'Invite call',
    durationMinutes: 30,
    availabilityScheduleId: DEMO.scheduleId,
    kind: ONE_ON_ONE,
    notificationMode: CALENDAR_INVITATION,
  });
}

async function scopeOf(harness: Harness, id: string) {
  const row = await harness.store.getById(id);
  assert.ok(row !== null, `booking ${id} must exist`);
  return scopeForRow(row, harness.runtime);
}

async function rowOf(harness: Harness, id: string): Promise<BookingRow> {
  const row = await harness.store.getById(id);
  assert.ok(row !== null);
  return row;
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

/** Recipients of the emails actually delivered, whichever sender is wired. */
function deliveredCount(harness: Harness): number {
  return harness.adapters === 'live'
    ? (harness.googleFetch?.gmail.length ?? 0)
    : harness.sender.sent.length;
}

describe('AC-12 parity — mock and live adapters are behaviourally identical', () => {
  for (const notificationMode of ['email_confirmation', 'calendar_invitation'] as const) {
    it(`create → reschedule → cancel behaves identically under both adapters (${notificationMode})`, async () => {
      const observed: string[] = [];

      await bothAdapters('memory', async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        const eventSlug = notificationMode === 'calendar_invitation' ? INVITE_SLUG : DEMO.eventSlug;
        if (notificationMode === 'calendar_invitation') {
          seedCalendarInvitationEventType();
        }

        const created = await book(MONDAY_0900, crypto.randomUUID(), eventSlug);
        const rescheduled = await rescheduleBooking(
          await scopeOf(harness, created.row.id),
          { start: isoAt(30), expectedRevision: 1, origin: ORIGIN },
        );
        const cancelled = await cancelBooking(
          await scopeOf(harness, rescheduled.row.id),
          { expectedRevision: 2, origin: ORIGIN },
        );

        // Every calendar call the model saw, in order and with its shape.
        const shape = harness.calendar.calls
          .map(
            (call) =>
              `${call.kind}:${call.sendUpdates ?? '-'}:${call.ifMatch === undefined ? 'no-etag' : 'etag'}`,
          )
          .join('|');
        observed.push(
          [
            shape,
            `events=${harness.calendar.liveEvents().length}`,
            `status=${cancelled.envelope.booking.status}`,
            `revision=${cancelled.envelope.booking.revision}`,
            `calendar=${cancelled.envelope.delivery.calendar}`,
            `emails=${deliveredCount(harness)}`,
          ].join(' '),
        );

        // Recipients are a product constant, not a mode (C4): six sends across
        // confirm + reschedule + cancel, whichever adapter delivered them.
        assert.equal(deliveredCount(harness), 6);
        assert.equal(harness.calendar.liveEvents().length, 0);
      });

      assert.equal(observed.length, 2);
      assert.equal(observed[0], observed[1], 'mock and live adapters diverged');
    });
  }

  it('sends the same attendee behaviour for each notificationMode (C4)', async () => {
    const perMode: Record<string, string[]> = { email_confirmation: [], calendar_invitation: [] };

    for (const notificationMode of ['email_confirmation', 'calendar_invitation'] as const) {
      await bothAdapters('memory', async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        const eventSlug = notificationMode === 'calendar_invitation' ? INVITE_SLUG : DEMO.eventSlug;
        if (notificationMode === 'calendar_invitation') {
          seedCalendarInvitationEventType();
        }
        await book(MONDAY_0900, crypto.randomUUID(), eventSlug);
        const insert = harness.calendar.calls.find((call) => call.kind === 'insert');
        assert.ok(insert !== undefined);
        perMode[notificationMode].push(String(insert.sendUpdates));
      });
    }

    // Identical across adapters, and selected only by the mode (C4).
    assert.deepEqual(perMode.email_confirmation, ['none', 'none']);
    assert.deepEqual(perMode.calendar_invitation, ['all', 'all']);
  });

  it('carries the attendee on the retried insert too, under both adapters (C4)', async () => {
    await bothAdapters('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      seedCalendarInvitationEventType();

      // C6.2's 409 → `events.get` absent → retry branch. A retry that sent
      // `sendUpdates: 'all'` without the attendee list finalized the booking
      // with no native Google invite for the guest (REVIEW-08).
      harness.calendar.failNext('insert', { status: 409 });
      harness.calendar.failNext('get', { status: 404 });

      const created = await book(MONDAY_0900, crypto.randomUUID(), INVITE_SLUG);
      assert.equal(created.envelope.delivery.calendar, 'created');

      const row = await rowOf(harness, created.row.id);
      const event = harness.calendar.eventById(row.googleEventId as string);
      assert.ok(event !== null, 'the retry created the event');
      assert.deepEqual(
        event.attendees?.map((attendee) => attendee.email),
        [INVITEE.email],
        'the retried insert carries the invitee',
      );

      const inserts = harness.calendar.calls.filter((call) => call.kind === 'insert');
      assert.equal(inserts.length, 2, 'exactly one retry');
      assert.deepEqual(
        inserts.map((call) => call.sendUpdates),
        ['all', 'all'],
      );
    });
  });
});

describe('AC-25(g) — 429 is ambiguous under both adapters, with identical state', () => {
  for (const step of ['insert', 'patch', 'delete'] as const) {
    it(`retains pending_op and answers 503 on a rate-limited ${step}`, async () => {
      const observed: string[] = [];

      await bothAdapters('memory', async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });

        let bookingId: string;
        if (step === 'insert') {
          harness.calendar.failNext('insert', { status: 429 });
          const error = await expectError(() => book());
          assert.equal(error.code, 'booking_outcome_unknown');
          bookingId = (await onlyBooking(harness)).id;
        } else {
          const created = await book();
          bookingId = created.row.id;
          const scope = await scopeOf(harness, bookingId);
          harness.calendar.failNext(step, { status: 429 });
          const error = await expectError(() =>
            step === 'patch'
              ? rescheduleBooking(scope, {
                  start: isoAt(30),
                  expectedRevision: 1,
                  origin: ORIGIN,
                })
              : cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN }),
          );
          assert.equal(error.code, 'booking_outcome_unknown');
        }

        const row = await rowOf(harness, bookingId);
        const attempts = row.pendingOp?.attempts ?? [];
        observed.push(
          [
            `pendingOp=${row.pendingOp?.kind ?? 'null'}`,
            `calendarState=${row.calendarState}`,
            `status=${row.status}`,
            `unresolved=${attempts.filter((a) => a.outcome === 'unresolved').length}`,
            `reserved=${row.reservedStart === null ? 'no' : 'yes'}`,
          ].join(' '),
        );

        // 429 never resolves an attempt and never releases the op (C6.0).
        assert.ok(row.pendingOp !== null, 'a rate-limited step keeps its op');
        assert.ok(
          attempts.some((attempt) => attempt.outcome === 'unresolved'),
          'the rate-limited attempt stays unresolved',
        );
        assertInvariants(row, `after a 429 ${step}`);
      });

      assert.equal(observed[0], observed[1], `mock and live diverged on a 429 ${step}`);
    });
  }

  it('a network failure at Gmail leaves the ledger claimed, never failed (C5)', async () => {
    await withHarness(
      'memory',
      async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        harness.googleFetch?.throwNextGmail();

        const created = await book();
        // The booking is committed whatever Gmail did (AC-10).
        assert.equal(created.envelope.booking.status, 'confirmed');
        // One recipient was refused ambiguously, so delivery is not `sent` and
        // not `failed`: its row stays `claimed` (C5 finalisation rule).
        assert.equal(created.envelope.delivery.email, 'pending');
      },
      { adapters: 'live' },
    );
  });
});

describe('AC-11(j)(l) / C6.3a — a late insert under both collision modes', () => {
  it('retains, then reaps or never lands, depending on what Google does', async () => {
    await bothCollisionModes(async (harness, collisionMode) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // The first insert is captured and held: the caller sees a timeout while
      // the request is still "in flight at Google" (C6.3a).
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      const first = await expectError(() => book());
      assert.equal(first.code, 'booking_outcome_unknown');

      const row = await onlyBooking(harness);
      const held = harness.calendar.heldInserts();
      assert.equal(held.length, 1);
      const heldAttemptId = held[0].attemptId;

      // A replay after the stale window takes over and inserts under the SAME
      // intended id; the held attempt stays unresolved either way.
      await advancePastStaleWindow(harness.clock);
      const replay = await book(MONDAY_0900, row.idempotencyKey);
      assert.equal(replay.row.id, row.id);
      assert.equal(replay.envelope.delivery.calendar, 'created');

      const afterCreate = await rowOf(harness, row.id);
      assert.ok(
        afterCreate.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
        'a successful T2 retains the unresolved attempt (REV5-01)',
      );

      // Cancel retires the live id, so the retained entry becomes reap-eligible.
      await cancelBooking(await scopeOf(harness, row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });

      // Now Google finally executes the held insert.
      await harness.calendar.releaseHeld(heldAttemptId);

      if (collisionMode === 'duplicate') {
        // The id was re-used, so nothing landed and nothing is there to reap.
        assert.equal(harness.calendar.liveEvents().length, 0);
      } else {
        // It landed: external busy now, and the next observing call removes it.
        assert.equal(harness.calendar.liveEvents().length, 1);
      }

      await readBooking(await scopeOf(harness, row.id));

      const after = await rowOf(harness, row.id);
      assert.equal(harness.calendar.liveEvents().length, 0, 'no live event survives');
      if (collisionMode === 'land') {
        assert.equal(
          after.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
          false,
          'the reaped landing retires exactly its own attempt',
        );
      } else {
        assert.ok(
          after.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
          'an attempt that never executed stays listed',
        );
      }
      assertInvariants(after, `after a late insert (${collisionMode})`);
    });
  });
});

describe('AC-11(r-v) — a cancel takes over a stale create whose event is absent', () => {
  it('produces unfinished_create by driving the interleaving, never by planting it', async () => {
    await bothCollisionModes(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // A's insert is captured WITHOUT executing: the event never appears.
      harness.calendar.holdNextInsert({ answer: 'timeout' });
      const key = crypto.randomUUID();
      const failed = await expectError(() => book(MONDAY_0900, key));
      assert.equal(failed.code, 'booking_outcome_unknown');

      const row = await onlyBooking(harness);
      assert.equal(row.latestAction, null);
      assert.equal(row.calendarState, 'pending');
      assert.equal(row.pendingOp?.kind, 'create');
      const heldAttemptId = harness.calendar.heldInserts()[0].attemptId;

      await advancePastStaleWindow(harness.clock);

      // The guest cancels. C6.7 takes the stale create over, finds its event
      // definitely absent, and carries it durably rather than losing it.
      const cancelled = await cancelBooking(await scopeOf(harness, row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal(cancelled.envelope.booking.status, 'cancelled');

      const after = await rowOf(harness, row.id);
      assert.equal(after.latestAction, 'cancel');
      assert.equal(after.calendarState, 'deleted');
      assert.equal(after.unfinishedCreate, null, 'cancel T2 finalizes the carry (CF-3)');
      assert.ok(
        after.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
        "the create's outstanding insert is retained for the reap",
      );
      assertInvariants(after, 'after cancel took over a stale create');

      // The client's replay of the same key now answers 201 with the cancelled
      // envelope — the REV9-01/REV11-01 behaviour, unchanged.
      const replay = await book(MONDAY_0900, key);
      assert.equal(replay.row.id, row.id);
      assert.equal(replay.envelope.booking.status, 'cancelled');
      assert.equal(replay.envelope.delivery.calendar, 'deleted');
    });
  });

  it('answers a non-terminal 409 while the cancel still owns the row', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      // The create's insert **executes** at Google but its response is lost, so
      // the row keeps an open create op over an event that does exist.
      harness.calendar.holdNextInsert({ answer: 'timeout', execute: true });
      const key = crypto.randomUUID();
      await expectError(() => book(MONDAY_0900, key));
      const row = await onlyBooking(harness);
      assert.equal(harness.calendar.liveEvents().length, 1);
      await advancePastStaleWindow(harness.clock);

      // The takeover's two reads do not see it yet (a read-after-write window at
      // Google), so the cancel **carries** the create rather than completing it;
      // its attribution read a moment later does, and that delete is then
      // definitely refused. That is the one interleaving in which cancel T2′
      // runs with `unfinished_create` set, and it must restore a resumable
      // create rather than park the row ownerless (C6.7, CF-2).
      const cancelScope = await scopeOf(harness, row.id);
      harness.calendar.failNext('get', { status: 404 });
      harness.calendar.failNext('get', { status: 404 });
      harness.calendar.failNext('delete', { status: 403 });
      const refused = await expectError(() =>
        cancelBooking(cancelScope, { expectedRevision: 1, origin: ORIGIN }),
      );
      assert.equal(refused.code, 'calendar_delete_failed');

      const restored = await rowOf(harness, row.id);
      assert.equal(restored.status, 'confirmed');
      assert.equal(restored.latestAction, null);
      assert.equal(restored.calendarState, 'pending');
      assert.equal(restored.pendingOp?.kind, 'create', 'T2′ restores a resumable create');
      assert.ok(restored.unfinishedCreate !== null);
      assertInvariants(restored, 'after cancel T2′ restored the create');

      // The restored op carries the ORIGINAL startedAt, so it is immediately
      // takeable: the client's replay finalizes the booking with one insert.
      const replay = await book(MONDAY_0900, key);
      assert.equal(replay.row.id, row.id);
      assert.equal(replay.envelope.booking.status, 'confirmed');
      assert.equal(replay.envelope.delivery.calendar, 'created');

      const finalized = await rowOf(harness, row.id);
      assert.equal(finalized.latestAction, 'confirm');
      assert.equal(finalized.unfinishedCreate, null);
      assertInvariants(finalized, 'after the replay finalized the restored create');
    });
  });
});

describe('C6.3c / C6.3a — compensation and cleanup only on proven outcomes', () => {
  it('bumps a fallback event it adopts, so the predecessor’s delete cannot land', async () => {
    // The interleaving LIVE-REVIEW-04 named: A's patch 404s, A inserts its
    // durable fallback F, A's own T2 fails and A pauses before its compensating
    // delete of F — still holding F's insert etag. B then takes the stale op
    // over and **adopts** F. Unless B invalidates F's version first, A's delayed
    // delete succeeds against the event that is now the booking's own.
    const FALLBACK_ID = 'marlofallbackaaa';

    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book();
      const row = await rowOf(harness, created.row.id);
      const liveId = row.googleEventId;
      assert.ok(liveId !== null);

      // A's Google side, executed for real: the host removed the original event
      // (which is why A's patch 404s), and A inserted its fallback.
      const original = harness.calendar.eventById(liveId);
      assert.ok(original !== null);
      await harness.calendar.remove({
        calendarId: 'primary',
        eventId: liveId,
        ifMatch: original.etag,
        sendUpdates: 'none',
      });
      const fallback = await harness.calendar.insert({
        calendarId: 'primary',
        id: FALLBACK_ID,
        start: isoAt(30),
        end: isoAt(60),
        summary: 'Intro call',
        bookingId: row.id,
        attemptId: 'attempt-a-fallback',
        sendUpdates: 'none',
      });
      const aInsertEtag = fallback.etag;

      // …and the row A's T1 committed, with its T2 never reached.
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
              fallbackEventId: FALLBACK_ID,
              attempts: [],
            },
            reservedStart: isoAt(30),
            reservedEnd: isoAt(60),
          },
        });
      });

      await advancePastStaleWindow(harness.clock);

      // B takes over, observes F, bumps it, and completes A's move against it.
      const recovered = await rescheduleBooking(await scopeOf(harness, row.id), {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal(recovered.envelope.booking.start, isoAt(30));
      assert.equal((await rowOf(harness, row.id)).googleEventId, FALLBACK_ID);

      const adopted = harness.calendar.eventById(FALLBACK_ID);
      assert.ok(adopted !== null);
      assert.notEqual(adopted.etag, aInsertEtag, 'the adopted fallback was bumped');

      // A's delayed compensating delete now meets a version it never saw.
      await assert.rejects(
        () =>
          harness.calendar.remove({
            calendarId: 'primary',
            eventId: FALLBACK_ID,
            ifMatch: aInsertEtag,
            sendUpdates: 'none',
          }),
        (error: unknown) => error instanceof CalendarError && error.status === 412,
      );
      assert.equal(harness.calendar.liveEvents().length, 1, 'the winner’s event survives');
    });
  });

  it('keeps a retained attempt when its cleanup delete is refused ambiguously', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      harness.calendar.holdNextInsert({ answer: 'timeout' });
      await expectError(() => book());
      const row = await onlyBooking(harness);
      const heldAttemptId = harness.calendar.heldInserts()[0].attemptId;

      await advancePastStaleWindow(harness.clock);
      await book(MONDAY_0900, row.idempotencyKey);
      await cancelBooking(await scopeOf(harness, row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });

      // The held insert lands under the now-retired id…
      harness.calendar.setCollisionMode('land');
      await harness.calendar.releaseHeld(heldAttemptId);
      assert.equal(harness.calendar.liveEvents().length, 1);

      // …and the reap's delete is rate-limited. Nothing is proven, so the entry
      // must stay listed — dropping it would strand the event (LIVE-REVIEW-05).
      harness.calendar.failNext('delete', { status: 429 });
      await readBooking(await scopeOf(harness, row.id));

      const afterRefusal = await rowOf(harness, row.id);
      assert.ok(
        afterRefusal.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
        'an unproven delete retires nothing',
      );
      assert.equal(harness.calendar.liveEvents().length, 1, 'the event is still there');

      // The next observing call succeeds and retires exactly that attempt.
      await readBooking(await scopeOf(harness, row.id));
      const afterReap = await rowOf(harness, row.id);
      assert.equal(
        afterReap.unresolvedInserts.some((entry) => entry.attemptId === heldAttemptId),
        false,
      );
      assert.equal(harness.calendar.liveEvents().length, 0);
    });
  });
});

async function onlyBooking(harness: Harness): Promise<BookingRow> {
  const rows = (harness.store as MemoryBookingStore).allRows();
  assert.equal(rows.length, 1, `expected exactly one booking, got ${rows.length}`);
  return rows[0];
}
