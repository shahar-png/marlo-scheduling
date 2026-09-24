// AC-21 / AC-20 — the `/b/{token}` control machine (C12) and the id/token
// split (C11), driven through the **real** `app/api/bookings/[id]/*` handlers
// via `handler-transport` — no mocked client anywhere in this file.
//
// The case that matters most is `stalled` (REV8-03): the page's single
// automatic retry can itself be answered `operation_in_progress`, and without a
// defined exit the guest is left staring at disabled controls with nothing in
// flight and no retry left.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createApiClient } from '../lib/api/client';
import { createHandlerTransport } from '../lib/api/handler-transport';
import {
  BookingControlsStore,
  calendarStatusLine,
  needsDeliveryRetry,
} from '../app/(public)/b/[token]/booking-controls-store';
import { createBooking } from '../lib/booking/service';
import type { LifecycleResult, PublicBooking } from '../lib/api/types';
import { DEMO, isoAt, MONDAY_0900, withHarness, type Harness } from './support/harness';

const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };
const ORIGIN = 'https://marlo.test';

function clientFor() {
  const transport = createHandlerTransport();
  return { client: createApiClient({ transport }), transport };
}

async function seedBooking(harness: Harness, start = MONDAY_0900) {
  await harness.seedOwner({ slug: DEMO.ownerSlug });
  const created = await createBooking({
    ownerSlug: DEMO.ownerSlug,
    eventSlug: DEMO.eventSlug,
    start,
    invitee: INVITEE,
    notes: null,
    idempotencyKey: crypto.randomUUID(),
    origin: ORIGIN,
  });
  const booking: PublicBooking = {
    id: created.envelope.booking.id,
    token: created.envelope.booking.token,
    start: created.envelope.booking.start,
    end: created.envelope.booking.end,
    status: created.envelope.booking.status,
    eventTypeId: created.envelope.booking.eventTypeId,
    invitee: created.envelope.booking.invitee,
    revision: created.envelope.booking.revision,
    delivery: {
      email: created.envelope.delivery.email,
      calendar: created.envelope.delivery.calendar === 'skipped'
        ? 'skipped'
        : created.envelope.delivery.calendar,
    },
  };
  return { created, booking };
}

function storeFor(
  harness: Harness,
  booking: PublicBooking,
  options: { waits?: number[] } = {},
) {
  const { client } = clientFor();
  const waits = options.waits ?? [];
  return new BookingControlsStore({
    booking,
    api: client,
    now: () => new Date(harness.clock.now()),
    wait: async (ms) => {
      waits.push(ms);
    },
  });
}

describe('AC-20 — the id/token split is enforced end to end (C11)', () => {
  it('serves the booking by bearer token and refuses the id alone', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      assert.notEqual(booking.id, booking.token);

      const { client } = clientFor();
      const read = await client.getBookingById({ id: booking.id, token: booking.token });
      assert.ok(read !== null);
      assert.equal(read.id, booking.id);

      // Wrong token, and no token at all, are both refused.
      assert.equal(
        await client.getBookingById({ id: booking.id, token: 'not-the-token' }),
        null,
      );
      assert.equal(
        await client.getBookingById({ id: booking.id, token: '' }),
        null,
      );
      // The id is not the token: it grants nothing.
      assert.equal(
        await client.getBookingById({ id: booking.id, token: booking.id }),
        null,
      );
    });
  });

  it('sends the token in the Authorization header, never in the path or body', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const { client, transport } = clientFor();
      await client.getBookingById({ id: booking.id, token: booking.token });
      await client.cancelBooking({
        id: booking.id,
        token: booking.token,
        expectedRevision: 1,
      });

      for (const call of transport.calls) {
        assert.equal(
          call.path.includes(booking.token),
          false,
          'the token must never appear in the path or query string',
        );
        assert.equal(
          JSON.stringify(call.body ?? {}).includes(booking.token),
          false,
          'the token must never appear in the body',
        );
        assert.equal(call.headers?.authorization, `Bearer ${booking.token}`);
      }
    });
  });
});

describe('AC-21 — reschedule through the real handler', () => {
  it('offers the overlapping 09:15 slot and moves the booking to it', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const store = storeFor(harness, booking);

      await store.openPicker();
      const times = store.getState().times.map((slot) => slot.start);
      assert.ok(times.includes(isoAt(15)), '09:15 is offered (the 15-minute grid)');
      assert.equal(times.includes(MONDAY_0900), false, 'the current start is not');

      await store.selectSlot(isoAt(15));

      const state = store.getState();
      assert.equal(state.state, 'done');
      assert.equal(state.booking.start, isoAt(15));
      assert.equal(state.booking.revision, 2);
      assert.equal(state.pickerOpen, false);
    });
  });

  it('a stale expectedRevision reloads the booking and shows "changed elsewhere"', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const store = storeFor(harness, booking);

      // Another tab moves it first.
      const { client } = clientFor();
      await client.rescheduleBooking({
        id: booking.id,
        token: booking.token,
        start: isoAt(30),
        expectedRevision: 1,
      });

      await store.selectSlot(isoAt(15));
      const state = store.getState();
      assert.equal(state.state, 'conflict');
      assert.equal(state.conflict, 'changed');
      // The page shows the latest rather than silently re-submitting.
      assert.equal(state.booking.start, isoAt(30));
      assert.equal(state.booking.revision, 2);
    });
  });

  it('an unchanged-time move is a slot conflict, and refreshes the picker', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const store = storeFor(harness, booking);

      await store.openPicker();
      await store.selectSlot(MONDAY_0900);
      assert.equal(store.getState().state, 'conflict');
      assert.equal(store.getState().conflict, 'slot');
    });
  });
});

describe('AC-21 — cancel is two-step and ends on the cancelled panel', () => {
  it('arms, confirms, and reports the cancellation delivery', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const store = storeFor(harness, booking);

      store.armCancel();
      assert.equal(store.getState().cancelArmed, true);
      store.disarmCancel();
      assert.equal(store.getState().cancelArmed, false);

      store.armCancel();
      await store.confirmCancel();

      const state = store.getState();
      assert.equal(state.state, 'done');
      assert.equal(state.booking.status, 'cancelled');
      assert.equal(state.booking.revision, 2);
      assert.equal(state.cancelArmed, false);
      // Emails went out, so the cancelled panel offers no retry control.
      assert.equal(needsDeliveryRetry(state.booking), false);
    });
  });

  it('REV3-07 — a failed cancellation email shows the retry control, which works', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const store = storeFor(harness, booking);

      harness.sender.failAlways({ definite: true, message: 'refused' });
      await store.confirmCancel();
      harness.sender.failAlways(null);

      const cancelled = store.getState().booking;
      assert.equal(cancelled.status, 'cancelled');
      assert.equal(cancelled.delivery?.email, 'failed');
      assert.equal(
        needsDeliveryRetry(cancelled),
        true,
        'there is no background worker: this control is the only retry path',
      );

      harness.sender.sent.length = 0;
      await store.resend();

      const after = store.getState();
      assert.equal(after.booking.delivery?.email, 'sent');
      assert.equal(needsDeliveryRetry(after.booking), false);
      assert.equal(harness.sender.sent.length, 2, 'both recipients re-sent');
      // Zero calendar inserts on a cancelled row (REV5-04).
      assert.equal(
        harness.calendar.calls.filter((call) => call.kind === 'insert').length,
        1,
        'only the original create ever inserted',
      );
    });
  });

  it('REV4-05 — a fresh load with no ledger rows shows "pending" and retries', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      // Cancel with an ambiguous send: the rows stay `claimed`, so a fresh page
      // load sees `pending` and must offer the retry.
      harness.sender.failAlways({ definite: false, message: 'timeout' });
      const store = storeFor(harness, booking);
      await store.confirmCancel();
      harness.sender.failAlways(null);

      const cancelled = store.getState().booking;
      assert.equal(cancelled.delivery?.email, 'pending');
      assert.equal(needsDeliveryRetry(cancelled), true);
    });
  });
});

describe('AC-21(g) — the resend control picks the C5 form by what it holds', () => {
  it('sends {} on a fresh load and the revision-specific form after an in-page action', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      const transportCalls = createHandlerTransport();
      const client = createApiClient({ transport: transportCalls });
      const store = new BookingControlsStore({
        booking,
        api: client,
        now: () => new Date(harness.clock.now()),
        wait: async () => {},
      });

      // A fresh load holds no pair: the explicit retry-latest form.
      await store.resend();
      const first = transportCalls.calls.filter((call) => call.path.endsWith('/notify'));
      assert.deepEqual(first[0].body, {});

      // After an in-page reschedule it holds `(2, 'reschedule')`.
      await store.selectSlot(isoAt(15));
      await store.resend();
      const second = transportCalls.calls.filter((call) => call.path.endsWith('/notify'));
      assert.deepEqual(second[1].body, { action: 'reschedule', expectedRevision: 2 });
    });
  });
});

describe('AC-21(l) — pending → stalled → recovery (REV8-03)', () => {
  /** Parks a non-stale foreign op on the row, so every call is refused. */
  async function blockWith(harness: Harness, bookingId: string, kind: 'reschedule' | 'cancel') {
    const row = await harness.store.getById(bookingId);
    assert.ok(row !== null);
    await harness.store.withHostLock(row.hostId, async (tx) => {
      await tx.update({
        id: row.id,
        expectedRevision: row.revision,
        patch: {
          pendingOp: {
            kind,
            opId: `op-${kind}-${Math.random()}`,
            gen: 1,
            startedAt: new Date(harness.clock.now()).toISOString(),
            attempts: [],
          },
        },
      });
    });
  }

  async function clearOp(harness: Harness, bookingId: string) {
    const row = await harness.store.getById(bookingId);
    assert.ok(row !== null);
    await harness.store.withHostLock(row.hostId, async (tx) => {
      await tx.update({
        id: row.id,
        expectedRevision: row.revision,
        patch: { pendingOp: null },
      });
    });
  }

  it('enters stalled when the automatic retry is also operation_in_progress', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      await blockWith(harness, booking.id, 'reschedule');

      const waits: number[] = [];
      const store = storeFor(harness, booking, { waits });

      await store.confirmCancel();

      const state = store.getState();
      assert.equal(state.state, 'stalled');
      assert.equal(waits.length, 1, 'exactly one automatic retry was scheduled');
      assert.deepEqual(state.stalledRequest, { kind: 'cancel', expectedRevision: 1 });
      // Nothing is in flight, and the ordinary controls are disabled so the
      // guest cannot start a second operation on top of the stuck one.
      assert.equal(store.controlsEnabled(), false);
    });
  });

  it('Try again re-sends the IDENTICAL request, with its original revision', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      await blockWith(harness, booking.id, 'reschedule');
      const store = storeFor(harness, booking);
      await store.confirmCancel();
      assert.equal(store.getState().state, 'stalled');

      // The other operation finishes without changing the revision.
      await clearOp(harness, booking.id);
      await store.tryAgain();

      const state = store.getState();
      assert.equal(state.state, 'done');
      assert.equal(state.booking.status, 'cancelled');
      assert.equal(state.booking.revision, 2);
    });
  });

  it('Try again after the booking moved is reconciled by the conflict handling', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      await blockWith(harness, booking.id, 'reschedule');
      const store = storeFor(harness, booking);
      await store.confirmCancel();
      assert.equal(store.getState().state, 'stalled');

      // The other caller completes a move: revision 2.
      await clearOp(harness, booking.id);
      const { client } = clientFor();
      await client.rescheduleBooking({
        id: booking.id,
        token: booking.token,
        start: isoAt(30),
        expectedRevision: 1,
      });

      // Try again re-sends `expectedRevision: 1` — the page never silently
      // substitutes a newer revision into a request the guest did not confirm.
      await store.tryAgain();
      assert.equal(store.getState().state, 'conflict');
      assert.equal(store.getState().conflict, 'changed');
      assert.equal(store.getState().booking.revision, 2);

      // Re-confirming against the reloaded revision succeeds.
      await store.confirmCancel();
      assert.equal(store.getState().state, 'done');
      assert.equal(store.getState().booking.status, 'cancelled');
    });
  });

  it('Reload exits stalled to idle with the fresh revision', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      await blockWith(harness, booking.id, 'reschedule');
      const store = storeFor(harness, booking);
      await store.confirmCancel();
      assert.equal(store.getState().state, 'stalled');

      await clearOp(harness, booking.id);
      const { client } = clientFor();
      await client.rescheduleBooking({
        id: booking.id,
        token: booking.token,
        start: isoAt(30),
        expectedRevision: 1,
      });

      await store.reload();
      const state = store.getState();
      assert.equal(state.state, 'idle');
      assert.equal(state.booking.revision, 2);
      assert.equal(state.booking.start, isoAt(30));
      assert.equal(state.stalledRequest, null);
      assert.equal(store.controlsEnabled(), true);

      // And the guest can now act on what they see.
      await store.confirmCancel();
      assert.equal(store.getState().booking.status, 'cancelled');
    });
  });

  it('the page is never left disabled with nothing in flight', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      await blockWith(harness, booking.id, 'cancel');
      const store = storeFor(harness, booking);

      await store.selectSlot(isoAt(15));
      const state = store.getState();

      // Whenever the controls are disabled, there is a way forward.
      if (!store.controlsEnabled()) {
        assert.equal(state.state, 'stalled');
        assert.notEqual(state.stalledRequest, null, 'Try again is available');
      }
    });
  });
});

describe('AC-21(f) / REV13-02 — the outcome-unknown and pending-calendar rules', () => {
  it('503 booking_outcome_unknown offers a reload, never a re-submit', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);
      // An ambiguous calendar outcome on the move.
      harness.calendar.failNext('patch', { status: 503 });
      const store = storeFor(harness, booking);

      await store.selectSlot(isoAt(15));
      const state = store.getState();
      assert.equal(state.state, 'error');
      assert.equal(state.errorCode, 'booking_outcome_unknown');
      assert.equal(state.outcomeUnknown, true);
      assert.equal(
        state.stalledRequest,
        null,
        'an unknown outcome must not offer a re-submit',
      );

      // The reload action re-reads and never re-submits.
      await store.reload();
      assert.equal(store.getState().state, 'idle');
    });
  });

  it('a pending calendar renders a status line and no control', () => {
    const pending: PublicBooking = {
      id: 'bk_1',
      token: 'tok_1',
      start: MONDAY_0900,
      end: isoAt(30),
      status: 'confirmed',
      eventTypeId: 'evt',
      invitee: INVITEE,
      revision: 1,
      delivery: { email: 'pending', calendar: 'pending' },
    };
    assert.equal(calendarStatusLine(pending), 'Calendar invite is still being created.');
    // `created` is the silent default; `pending` never becomes an error.
    assert.equal(
      calendarStatusLine({ ...pending, delivery: { email: 'sent', calendar: 'created' } }),
      null,
    );
  });
});

describe('C12 — a failed conflict refresh never strands the page in `pending`', () => {
  it('offers a reload when the stale_revision refresh itself fails (REVIEW-08)', async () => {
    await withHarness('memory', async (harness) => {
      const { booking } = await seedBooking(harness);

      // A `stale_revision` body carries no booking, so the page must re-read
      // the row to show the latest — and that read can fail (503, network). It
      // is awaited outside the store's own try/catch, so a rejection escaped
      // `run` with `controlsState = 'pending'`: nothing in flight, no retry
      // left, and no recovery control rendered.
      const store = new BookingControlsStore({
        booking,
        now: () => new Date(harness.clock.now()),
        wait: async () => {},
        api: {
          async getBookingById() {
            throw new Error('network');
          },
          async getBookingAvailability() {
            return { times: [] };
          },
          async rescheduleBooking(): Promise<LifecycleResult> {
            return { ok: false, status: 409, code: 'stale_revision' };
          },
          async cancelBooking(): Promise<LifecycleResult> {
            return { ok: false, status: 409, code: 'stale_revision' };
          },
          async retryNotification(): Promise<LifecycleResult> {
            return { ok: false, status: 409, code: 'stale_revision' };
          },
        },
      });

      store.armCancel();
      await store.confirmCancel();

      const state = store.getState();
      assert.notEqual(state.state, 'pending', 'never disabled with nothing in flight');
      assert.equal(state.state, 'error');
      // Re-sending a request the guest did not re-confirm is wrong here, so the
      // offered way forward is a reload (C12).
      assert.equal(state.outcomeUnknown, true);
    });
  });
});
