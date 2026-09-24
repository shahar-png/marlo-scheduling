// C5 — the notify route's ONE normative ordering (REV15-01).
//
// `POST /api/bookings/{id}/notify` is two things behind one route, and rev 15
// stated the second's NULL-pair refusal without saying it runs after the first.
// The ordering is now explicit, and a **claim is never a recovery**:
//
//   N-1  lifecycle recovery — `resumeCreate` (C6.4), the stale-`calendar_repair`
//        takeover (REV4-04), and the `operation_in_progress` refusals. This
//        phase writes ZERO `notification_deliveries` rows; when it completes an
//        inherited create, that create's own T2 issues the `(1, 'confirm')`
//        claim.
//   N-2  repair / reap — C6.8 repair on a confirmed `failed` row, the bounded
//        C6.3a reap on a cancelled one. Never `events.insert`/`patch` on a
//        cancelled row (REV5-04).
//   N-3  the notification claim — and only now. The NULL-pair refusal applies
//        **here and only here**, and CF-2 plus N-1 make it unreachable on any
//        committed row: it is a defensive invariant check, logged
//        `notify_no_pair`, asserted suite-wide never to fire.

import { logLifecycle } from '../booking/log';
import {
  NotifyRequestInvalidError,
  OperationInProgressError,
  StaleRevisionError,
} from '../booking/errors';
import { hasEligibleReap, reapRetiredIds } from '../booking/reap';
import { repairCalendar } from '../booking/repair';
import {
  isStaleOp,
  retryAfterSeconds,
  type BookingRow,
  type LatestAction,
} from '../booking/rows';
import type { LifecycleContext } from '../booking/ops';
import type { DeliveryAction, DeliveryRecipient } from '../booking/store';
import { REQUIRED_RECIPIENTS } from './ledger';

export type NotifyRequestBody = {
  action?: unknown;
  expectedRevision?: unknown;
};

export type NotifyRequest =
  /** Revision-specific retry: both fields, validated together. */
  | { form: 'revision'; action: DeliveryAction; expectedRevision: number }
  /** Explicit retry-latest: neither field. */
  | { form: 'latest' };

export function parseNotifyRequest(body: NotifyRequestBody): NotifyRequest {
  const hasAction = body.action !== undefined && body.action !== null;
  const hasRevision = body.expectedRevision !== undefined && body.expectedRevision !== null;

  if (!hasAction && !hasRevision) {
    return { form: 'latest' };
  }
  if (hasAction !== hasRevision) {
    // One without the other is invalid (C5).
    throw new NotifyRequestInvalidError();
  }
  const action = body.action;
  if (action !== 'confirm' && action !== 'reschedule' && action !== 'cancel') {
    throw new NotifyRequestInvalidError();
  }
  const expectedRevision = body.expectedRevision;
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
    throw new NotifyRequestInvalidError();
  }
  return { form: 'revision', action, expectedRevision };
}

export type NotifyPhases = {
  ctx: LifecycleContext;
  /** N-1: completes an inherited create and issues its own `(1, confirm)`. */
  resumeCreate: (row: BookingRow) => Promise<BookingRow>;
  /** N-2 repair input. */
  repair: { eventName: string; invitee: { name: string; email: string } };
  /** N-3: sends the claims N-3 acquired under the lock. Never claims itself. */
  send: (
    row: BookingRow,
    action: DeliveryAction,
    claims: RecipientClaim[],
  ) => Promise<void>;
};

/** One acquired claim: the recipient and the generation every finalise carries. */
export type RecipientClaim = { recipient: DeliveryRecipient; gen: number };

export type NotifyResult = {
  row: BookingRow;
  /** Which pair N-3 retried, echoed in the response (C5). */
  retried: { revision: number; action: DeliveryAction } | null;
};

export async function runNotify(
  phases: NotifyPhases,
  bookingId: string,
  request: NotifyRequest,
): Promise<NotifyResult> {
  const { ctx } = phases;

  // ---- N-1 lifecycle recovery -------------------------------------------
  let row = await requireRow(ctx, bookingId);
  const op = row.pendingOp;
  if (op !== null) {
    if (op.kind === 'create') {
      if (!isStaleOp(op, ctx.clock.now())) {
        // Owned elsewhere: nothing claimed and nothing sent.
        throw new OperationInProgressError(retryAfterSeconds(op, ctx.clock.now()));
      }
      // Stale → take over and COMPLETE it. Its own T2/T2′ writes the non-null
      // `latest_action`, clears `unfinished_create`, and issues the
      // `(revision, 'confirm')` claim — that claim belongs to the create.
      row = await phases.resumeCreate(row);
    } else if (op.kind === 'calendar_repair') {
      if (!isStaleOp(op, ctx.clock.now())) {
        throw new OperationInProgressError(retryAfterSeconds(op, ctx.clock.now()));
      }
      await repairCalendar(ctx, row, phases.repair);
      row = await requireRow(ctx, bookingId);
    } else {
      // A reschedule or cancel op, stale or not: taken over only by lifecycle
      // calls, never by notify.
      throw new OperationInProgressError(retryAfterSeconds(op, ctx.clock.now()));
    }
  }

  // ---- N-2 repair / reap -------------------------------------------------
  if (row.status === 'confirmed' && row.calendarState === 'failed' && row.pendingOp === null) {
    await repairCalendar(ctx, row, phases.repair);
    row = await requireRow(ctx, bookingId);
  } else if (row.status === 'cancelled' && hasEligibleReap(row)) {
    // Cleanup only: zero `events.insert` / `events.patch` on a cancelled row.
    await reapRetiredIds(ctx, row.id);
    row = await requireRow(ctx, bookingId);
  }

  // ---- N-3 notification claim -------------------------------------------
  //
  // The validation and the claim happen in ONE host-locked transaction, under
  // the booking's `FOR UPDATE` read (C5). Validating against an unlocked
  // snapshot would let a cancel commit in between and a fresh claim be acquired
  // for a pair that is already superseded — which is a different thing from the
  // accepted case of an *already-claimed* send arriving late (REV5-05).
  const claimed = await ctx.store.withHostLock(row.hostId, async (tx) => {
    const locked = await tx.selectForUpdate(bookingId);
    if (locked === null) {
      throw new OperationInProgressError(1);
    }
    if (locked.latestAction === null) {
      // Defensive: CF-2 (`pending_op IS NULL ⇒ latest_action IS NOT NULL`)
      // together with N-1 makes this unreachable on any committed row.
      logLifecycle('notify_no_pair', { bookingId: locked.id, revision: locked.revision });
      throw new StaleRevisionError(locked.revision, null);
    }
    const action: LatestAction = locked.latestAction;
    if (request.form === 'revision') {
      if (locked.revision !== request.expectedRevision || action !== request.action) {
        // A send for an older pair is refused BEFORE claiming, so a late
        // confirmation can never mark a reschedule/cancel delivery `sent`.
        throw new StaleRevisionError(locked.revision, action);
      }
    }

    const claims: RecipientClaim[] = [];
    for (const recipient of REQUIRED_RECIPIENTS) {
      const acquired = await tx.claimDelivery({
        bookingId: locked.id,
        revision: locked.revision,
        action,
        recipient,
        nowMs: ctx.clock.now(),
      });
      if (acquired !== null) {
        claims.push({ recipient, gen: acquired.gen });
      }
    }
    return { row: locked, action, claims };
  });

  // Only now, with the claim transaction committed, does anything reach Gmail.
  await phases.send(claimed.row, claimed.action, claimed.claims);
  const fresh = await requireRow(ctx, bookingId);
  return {
    row: fresh,
    retried: { revision: claimed.row.revision, action: claimed.action },
  };
}

async function requireRow(ctx: LifecycleContext, bookingId: string): Promise<BookingRow> {
  const row = await ctx.store.getById(bookingId);
  if (row === null) {
    throw new OperationInProgressError(1);
  }
  return row;
}
