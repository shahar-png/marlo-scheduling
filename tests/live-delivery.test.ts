// AC-13 / AC-23 — the C5 delivery ledger and the C5 notify ordering
// (N-1 recovery → N-2 repair/reap → N-3 claim), on both stores.
//
// Three of these cases exist to prove a guarantee the PLAN *narrowed* rather
// than one it kept: an already-claimed send really is issued after a later
// revision's mail (REV5-05), stalled generations really do cluster (REV6-04),
// and a definitely-refused send really is re-claimable immediately (REV7-04).

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  cancelBooking,
  createBooking,
  notifyBooking,
  readBooking,
  rescheduleBooking,
  scopeForRow,
} from '../lib/booking/service';
import { LifecycleError } from '../lib/booking/errors';
import { claim, finalize, summarizeDelivery } from '../lib/notify/ledger';
import { lifecycleLogCount, resetLifecycleLog } from '../lib/booking/log';
import { CLAIM_STALE_MS } from '../lib/booking/rows';
import type { DeliveryRow } from '../lib/booking/store';
import { bothStores, DEMO, isoAt, MONDAY_0900, type Harness } from './support/harness';

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

describe('AC-13 — both parties are emailed for every action (C4)', () => {
  it('sends confirm, reschedule, and cancel to invitee and owner', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug, firstName: 'Marlo' });
      const created = await book(harness);

      const rescheduleScope = await scopeOf(harness, created.row.id);
      await rescheduleBooking(rescheduleScope, {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });
      const cancelScope = await scopeOf(harness, created.row.id);
      await cancelBooking(cancelScope, { expectedRevision: 2, origin: ORIGIN });

      for (const action of ['confirm', 'reschedule', 'cancel'] as const) {
        const forAction = harness.sender.sent.filter((entry) => entry.action === action);
        assert.deepEqual(
          forAction.map((entry) => entry.recipient).sort(),
          ['invitee', 'owner'],
          `${action} reaches both parties exactly once`,
        );
      }

      // Every body links to the booking page (C4 / REV6-05).
      const token = created.envelope.booking.token;
      for (const entry of harness.sender.sent) {
        assert.ok(
          entry.body.includes(`${ORIGIN}/b/${token}`),
          `${entry.action}/${entry.recipient} must link to the booking page`,
        );
      }

      // Cancel copy is its own, never the confirmation intro.
      const cancelBodies = harness.sender.sent.filter((entry) => entry.action === 'cancel');
      const confirmBodies = harness.sender.sent.filter((entry) => entry.action === 'confirm');
      for (const cancelled of cancelBodies) {
        for (const confirmed of confirmBodies) {
          assert.notEqual(firstLine(cancelled.body), firstLine(confirmed.body));
        }
      }
    });
  });

  it('a committed booking whose email fails is still 201 with delivery.email failed', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.sender.failAlways({ definite: true, message: 'refused' });

      const created = await book(harness);
      assert.equal(created.envelope.booking.status, 'confirmed');
      assert.equal(created.envelope.delivery.email, 'failed');
      assert.equal(created.envelope.delivery.calendar, 'created');
    });
  });
});

describe('AC-13 — the claim is atomic and generation-carrying (C5)', () => {
  it('two simultaneous retries produce exactly one send per recipient', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      // Wipe the ledger's effect by re-claiming from a clean slate: the create
      // already claimed, so use a fresh (revision, action) pair.
      const both = await Promise.all([
        claim({
          store: harness.store,
          bookingId: created.row.id,
          revision: 9,
          action: 'confirm',
          recipient: 'invitee',
          nowMs: harness.clock.now(),
        }),
        claim({
          store: harness.store,
          bookingId: created.row.id,
          revision: 9,
          action: 'confirm',
          recipient: 'invitee',
          nowMs: harness.clock.now(),
        }),
      ]);
      const winners = both.filter((entry) => entry !== null);
      assert.equal(winners.length, 1, 'only one caller may send');
      assert.equal(winners[0]?.gen, 1);
    });
  });

  it('a late finaliser after a takeover updates nothing (REV2-06)', async () => {
    await bothStores(async (harness) => {
      resetLifecycleLog();
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const key = {
        store: harness.store,
        bookingId: created.row.id,
        revision: 7,
        action: 'cancel' as const,
        recipient: 'owner' as const,
      };

      const first = await claim({ ...key, nowMs: harness.clock.now() });
      assert.equal(first?.gen, 1);

      // Worker A stalls past the stale window; B re-claims and finalises.
      await harness.clock.advance(CLAIM_STALE_MS + 1_000);
      const second = await claim({ ...key, nowMs: harness.clock.now() });
      assert.equal(second?.gen, 2);
      assert.equal(await finalize({ ...key, nowMs: harness.clock.now(), gen: 2, state: 'sent' }), true);

      // A's late finalisation carries gen 1 and must change nothing.
      const before = lifecycleLogCount('stale_finalize_ignored');
      const applied = await finalize({
        ...key,
        nowMs: harness.clock.now(),
        gen: 1,
        state: 'failed',
      });
      assert.equal(applied, false);
      assert.equal(lifecycleLogCount('stale_finalize_ignored'), before + 1);

      const rows = await harness.store.deliveryRows(created.row.id, 7, 'cancel');
      assert.equal(rows[0].state, 'sent', 'the winner’s row is untouched');
    });
  });

  it('a failed row is re-claimable immediately; a claimed one only after the window', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const key = {
        store: harness.store,
        bookingId: created.row.id,
        revision: 5,
        action: 'confirm' as const,
        recipient: 'invitee' as const,
      };

      // A definite refusal → `failed` → re-claimable with NO age condition.
      assert.equal((await claim({ ...key, nowMs: harness.clock.now() }))?.gen, 1);
      await finalize({ ...key, nowMs: harness.clock.now(), gen: 1, state: 'failed' });
      await harness.clock.advance(1_000);
      assert.equal(
        (await claim({ ...key, nowMs: harness.clock.now() }))?.gen,
        2,
        'a failed row is re-claimable immediately (REV7-04)',
      );

      // Now it is `claimed` (outcome unresolved): the window applies.
      await harness.clock.advance(1_000);
      assert.equal(await claim({ ...key, nowMs: harness.clock.now() }), null);
      await harness.clock.advance(CLAIM_STALE_MS);
      assert.equal((await claim({ ...key, nowMs: harness.clock.now() }))?.gen, 3);
    });
  });

  it('AC-13(l) — repeated immediate failed retries raise attempts, not copies', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.sender.failAlways({ definite: true, message: 'refused' });
      const created = await book(harness);

      // The create's own send was refused: `failed`, zero deliveries.
      assert.equal(created.envelope.delivery.email, 'failed');
      assert.equal(harness.sender.sent.length, 0, 'a refused send delivers nothing');

      for (const step of [1, 2]) {
        await harness.clock.advance(1_000);
        const scope = await scopeOf(harness, created.row.id);
        const outcome = await notifyBooking(scope, {}, ORIGIN);
        assert.equal(outcome.envelope.delivery.email, 'failed', `retry ${step}`);
      }

      const rows = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
      // Three generations per recipient, zero copies delivered.
      for (const row of rows) {
        assert.equal(row.attempts, 3);
        assert.equal(row.state, 'failed');
      }
      assert.equal(harness.sender.sent.length, 0);

      // Repaired: one more generation, and now exactly one copy each.
      harness.sender.failAlways(null);
      await harness.clock.advance(1_000);
      const scope = await scopeOf(harness, created.row.id);
      const repaired = await notifyBooking(scope, {}, ORIGIN);
      assert.equal(repaired.envelope.delivery.email, 'sent');
      assert.deepEqual(
        harness.sender.sent.map((entry) => entry.recipient).sort(),
        ['invitee', 'owner'],
      );
      const after = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
      for (const row of after) {
        assert.equal(row.attempts, 4);
        assert.ok(
          harness.sender.sent.filter((entry) => entry.recipient === row.recipient).length <=
            row.attempts,
          'copies never exceed attempts',
        );
      }
    });
  });

  it('an AMBIGUOUS send outcome leaves the row claimed, not failed', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.sender.failAlways({ definite: false, message: 'timeout' });

      const created = await book(harness);
      // Gmail may have accepted it, so the row stays `claimed` → `pending`.
      assert.equal(created.envelope.delivery.email, 'pending');
      const rows = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
      assert.ok(rows.every((row) => row.state === 'claimed'));

      // Inside the window, a retry claims nothing.
      harness.sender.failAlways(null);
      await harness.clock.advance(1_000);
      const scope = await scopeOf(harness, created.row.id);
      const early = await notifyBooking(scope, {}, ORIGIN);
      assert.equal(early.envelope.delivery.email, 'pending');
      assert.equal(harness.sender.sent.length, 0);

      // After it, exactly one copy each.
      await harness.clock.advance(CLAIM_STALE_MS);
      const late = await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);
      assert.equal(late.envelope.delivery.email, 'sent');
      assert.equal(harness.sender.sent.length, 2);
    });
  });
});

describe('AC-13 — delivery.email is computed over the required recipient set (REV4-05)', () => {
  it('a recipient with no row at all is pending, and notify claims it', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);

      // Death between recipients: drop the owner's row.
      const rows = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
      assert.equal(rows.length, 2);
      assert.equal(summarizeDelivery(rows), 'sent');
      const inviteeOnly = rows.filter((row) => row.recipient === 'invitee');
      assert.equal(
        summarizeDelivery(inviteeOnly),
        'pending',
        'a missing row is pending, never sent',
      );

      // And `failed` dominates.
      const withFailure: DeliveryRow[] = [
        ...inviteeOnly,
        { ...rows[0], recipient: 'owner', state: 'failed' },
      ];
      assert.equal(summarizeDelivery(withFailure), 'failed');
    });
  });
});

describe('AC-13(c) — an already-claimed send is NOT ordered against lifecycle changes', () => {
  it('issues a revision-1 confirmation after the cancellation mail (REV5-05)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      // Worker A is the create's own send: it claims `(1, 'confirm')` for both
      // recipients and then stalls before reaching Gmail. An unresolved outcome
      // is exactly what leaves the rows `claimed` at generation 1 (C5).
      harness.sender.failAlways({ definite: false, message: 'stalled before send' });
      const created = await book(harness);
      harness.sender.failAlways(null);
      harness.sender.sent.length = 0;

      const claims = [] as Array<{ recipient: 'invitee' | 'owner'; gen: number }>;
      for (const recipient of ['invitee', 'owner'] as const) {
        const rows = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
        const row = rows.find((entry) => entry.recipient === recipient);
        assert.ok(row !== undefined && row.state === 'claimed');
        claims.push({ recipient, gen: row.attempts });
      }

      // Meanwhile the booking is cancelled and revision 2's mail goes out.
      const scope = await scopeOf(harness, created.row.id);
      await cancelBooking(scope, { expectedRevision: 1, origin: ORIGIN });
      assert.deepEqual(
        harness.sender.sent.map((entry) => entry.action),
        ['cancel', 'cancel'],
      );

      // A resumes: its revision-1 confirmations ARE sent, after the cancellation.
      for (const entry of claims) {
        await harness.runtime.sender.send({
          to: entry.recipient === 'owner' ? 'demo@example.com' : INVITEE.email,
          from: 'marlo@example.com',
          subject: 'Confirmed',
          body: 'stale confirmation',
          ics: { filename: 'invite.ics', content: '' },
          action: 'confirm',
          recipient: entry.recipient,
          revision: 1,
          bookingId: created.row.id,
        });
        await finalize({
          store: harness.store,
          bookingId: created.row.id,
          revision: 1,
          action: 'confirm',
          recipient: entry.recipient,
          nowMs: harness.clock.now(),
          gen: entry.gen,
          state: 'sent',
        });
      }

      assert.deepEqual(
        harness.sender.sent.map((entry) => entry.action),
        ['cancel', 'cancel', 'confirm', 'confirm'],
        'the confirmation really does arrive after the cancellation',
      );

      // The ledger stays generation-correct: only (1, confirm) moved.
      const cancelRows = await harness.store.deliveryRows(created.row.id, 2, 'cancel');
      assert.ok(cancelRows.every((row) => row.state === 'sent'));
      const confirmRows = await harness.store.deliveryRows(created.row.id, 1, 'confirm');
      assert.ok(confirmRows.every((row) => row.state === 'sent'));

      // And a revision-specific retry of the old pair is refused.
      const error = await expectError(async () =>
        notifyBooking(
          await scopeOf(harness, created.row.id),
          { action: 'confirm', expectedRevision: 1 },
          ORIGIN,
        ),
      );
      assert.equal(error.code, 'stale_revision');
      assert.deepEqual(error.body, { revision: 2, latestAction: 'cancel' });
    });
  });
});

describe('AC-13(k) — stalled generations cluster; attempts is the exact bound (REV6-04)', () => {
  it('four generations claimed across four windows deliver four copies at once', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const key = {
        store: harness.store,
        bookingId: created.row.id,
        revision: 3,
        action: 'reschedule' as const,
        recipient: 'invitee' as const,
      };

      const gens: number[] = [];
      for (let index = 0; index < 4; index += 1) {
        const acquired = await claim({ ...key, nowMs: harness.clock.now() });
        assert.ok(acquired !== null, `generation ${index + 1} must be claimable`);
        gens.push(acquired.gen);
        // Each worker pauses before Gmail; the next window opens.
        await harness.clock.advance(CLAIM_STALE_MS + 1_000);
      }
      assert.deepEqual(gens, [1, 2, 3, 4]);

      // All four resume at once.
      harness.sender.sent.length = 0;
      for (const gen of gens) {
        await harness.runtime.sender.send({
          to: INVITEE.email,
          from: 'marlo@example.com',
          subject: 'Moved',
          body: `copy for generation ${gen}`,
          ics: { filename: 'invite.ics', content: '' },
          action: 'reschedule',
          recipient: 'invitee',
          revision: 3,
          bookingId: created.row.id,
        });
      }

      const rows = await harness.store.deliveryRows(created.row.id, 3, 'reschedule');
      const attempts = rows.find((row) => row.recipient === 'invitee')?.attempts;
      assert.equal(attempts, 4);
      assert.equal(
        harness.sender.sent.length,
        4,
        'the cluster is real — the PLAN does not pretend to prevent it',
      );
      assert.equal(harness.sender.sent.length, attempts, 'copies === attempts, the exact bound');
    });
  });
});

describe('AC-23 / C5 — the notify ordering N-1 → N-2 → N-3 (REV15-01)', () => {
  it('N-3 refuses a stale pair and sends nothing', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      await rescheduleBooking(await scopeOf(harness, created.row.id), {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });
      harness.sender.sent.length = 0;

      const error = await expectError(async () =>
        notifyBooking(
          await scopeOf(harness, created.row.id),
          { action: 'confirm', expectedRevision: 1 },
          ORIGIN,
        ),
      );
      assert.equal(error.code, 'stale_revision');
      assert.equal(harness.sender.sent.length, 0);
    });
  });

  it('the retry-latest form claims the current pair and echoes it', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      await rescheduleBooking(await scopeOf(harness, created.row.id), {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });

      const outcome = await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);
      assert.deepEqual(outcome.retried, { revision: 2, action: 'reschedule' });
    });
  });

  it('rejects one field without the other (400 notify_request_invalid)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      const scope = await scopeOf(harness, created.row.id);

      for (const body of [{ action: 'confirm' }, { expectedRevision: 1 }]) {
        const error = await expectError(() => notifyBooking(scope, body, ORIGIN));
        assert.equal(error.code, 'notify_request_invalid');
        assert.equal(error.status, 400);
      }
    });
  });

  it('a second notify after full success is a no-op 200', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      harness.sender.sent.length = 0;

      const outcome = await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);
      assert.equal(outcome.envelope.delivery.email, 'sent');
      assert.equal(harness.sender.sent.length, 0, 'a `sent` row is never re-sent');
    });
  });

  it('N-1 refuses while a reschedule or cancel owns the op, writing no ledger row', async () => {
    for (const kind of ['reschedule', 'cancel'] as const) {
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
                kind,
                opId: `op-${kind}`,
                gen: 1,
                startedAt: new Date(harness.clock.now()).toISOString(),
                attempts: [],
              },
            },
          });
        });
        harness.sender.sent.length = 0;

        const error = await expectError(async () =>
          notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN),
        );
        assert.equal(error.code, 'operation_in_progress');
        assert.equal(harness.sender.sent.length, 0);
      });
    }
  });

  it('N-2 on a CANCELLED row never inserts or patches (REV5-04)', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await book(harness);
      // A definite calendar failure, then a cancel: `calendar_state` has been
      // `failed`, which is exactly the state that tempts a repair.
      await cancelBooking(await scopeOf(harness, created.row.id), {
        expectedRevision: 1,
        origin: ORIGIN,
      });
      harness.calendar.calls.length = 0;
      harness.sender.failAlways({ definite: true, message: 'refused' });
      await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN).catch(
        () => undefined,
      );
      harness.sender.failAlways(null);
      await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);

      const mutations = harness.calendar.calls.filter(
        (call) => call.kind === 'insert' || call.kind === 'patch',
      );
      assert.equal(mutations.length, 0, 'zero inserts and zero patches on a cancelled row');
    });
  });

  it('the defensive notify_no_pair check never fires (CF-2 + N-1)', async () => {
    // Asserted over this whole file's work, as AC-11 requires suite-wide.
    assert.equal(lifecycleLogCount('notify_no_pair'), 0);
  });
});

describe('AC-23 — calendar repair is an owned operation (C6.8)', () => {
  it('repairs a failed row under the SAME intended id and reports created', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.calendar.failNext('insert', { status: 403 });
      const created = await book(harness);
      assert.equal(created.envelope.delivery.calendar, 'failed');

      const before = await harness.store.getById(created.row.id);
      const intendedId = before?.googleEventId;
      harness.calendar.calls.length = 0;

      const repaired = await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);
      assert.equal(repaired.envelope.delivery.calendar, 'created');

      const inserts = harness.calendar.calls.filter((call) => call.kind === 'insert');
      assert.equal(inserts.length, 1);
      assert.equal(inserts[0].eventId, intendedId, 'repair uses the persisted intended id');

      const after = await harness.store.getById(created.row.id);
      assert.equal(after?.calendarState, 'created');
      assert.equal(after?.pendingOp, null);

      // A second notify repairs nothing.
      harness.calendar.calls.length = 0;
      await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);
      assert.equal(
        harness.calendar.calls.filter((call) => call.kind === 'insert').length,
        0,
      );
    });
  });

  it('a definite repair failure keeps calendar_state failed and still retries email', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.calendar.failNext('insert', { status: 403 });
      harness.sender.failAlways({ definite: true, message: 'refused' });
      const created = await book(harness);
      harness.sender.failAlways(null);

      harness.calendar.failNext('insert', { status: 403 });
      const outcome = await notifyBooking(await scopeOf(harness, created.row.id), {}, ORIGIN);

      assert.equal(outcome.envelope.delivery.calendar, 'failed');
      assert.equal(outcome.envelope.delivery.email, 'sent', 'emails are still retried');
      const after = await harness.store.getById(created.row.id);
      assert.equal(after?.pendingOp, null);
    });
  });

  it('the read surface mirrors calendar_state through every transition', async () => {
    await bothStores(async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });

      const created = await book(harness);
      assert.equal((await readBooking(await scopeOf(harness, created.row.id))).delivery.calendar, 'created');

      await rescheduleBooking(await scopeOf(harness, created.row.id), {
        start: isoAt(30),
        expectedRevision: 1,
        origin: ORIGIN,
      });
      assert.equal((await readBooking(await scopeOf(harness, created.row.id))).delivery.calendar, 'created');

      await cancelBooking(await scopeOf(harness, created.row.id), {
        expectedRevision: 2,
        origin: ORIGIN,
      });
      assert.equal((await readBooking(await scopeOf(harness, created.row.id))).delivery.calendar, 'deleted');

      harness.calendar.failNext('insert', { status: 403 });
      const failed = await book(harness, isoAt(120));
      assert.equal(failed.envelope.delivery.calendar, 'failed');
      assert.equal((await readBooking(await scopeOf(harness, failed.row.id))).delivery.calendar, 'failed');
    });
  });
});

function firstLine(body: string): string {
  return body.split('\n').find((line) => line.trim() !== '') ?? '';
}
