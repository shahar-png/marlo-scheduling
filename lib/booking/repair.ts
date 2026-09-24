// C6.8 — calendar repair as an explicit **owned** operation.
//
// Repair is reachable only from `status='confirmed' AND calendar_state='failed'
// AND pending_op IS NULL`, is serialized with reschedule/cancel through
// `pending_op`, targets the row's persisted intended id, and **removes nothing
// from `unresolved_inserts`**: an entry naming the live id is simply not
// reap-eligible, the id was never retired, and because retired is absorbing no
// reaper — sequential or paused — can delete a repaired event (REV5-02).
//
// A repair is never run on a cancelled row (that is the reap's job — cleanup,
// not repair: REV5-04), and repair T2 has **no compensation**, because the
// inserted event *is* the booking's intended event (REV4-04).

import {
  BookingOutcomeUnknownError,
  OperationInProgressError,
  RepairFailedError,
} from './errors';
import { newOperationId } from './ids';
import {
  acquireStaleOp,
  beginOp,
  finishAttempt,
  newAttempt,
  observeId,
  unobserved,
  verifyInsert,
  writeAttempt,
  classifyCalendarError,
  OUTCOME_DEFINITE,
  type LifecycleContext,
} from './ops';
import { isStaleOp, retainedFrom, retryAfterSeconds, type BookingRow, type PendingOp } from './rows';
import { settleCompletion } from './settle';
import { cleanupOwnEvent, reconcileSuperseded } from './superseded';

export type RepairRequest = {
  eventName: string;
  invitee: { name: string; email: string };
};

export type RepairOutcome = {
  /** The calendar state the repair left behind. */
  calendarState: 'created' | 'failed';
  row: BookingRow;
};

/**
 * Begins (or takes over a **stale**) `calendar_repair` and resumes it at the
 * observed step. Returns `null` when the row needs no repair.
 */
export async function repairCalendar(
  ctx: LifecycleContext,
  row: BookingRow,
  request: RepairRequest,
): Promise<RepairOutcome | null> {
  if (row.status !== 'confirmed') {
    // A cancelled row is cleanup only — never repair (REV5-04).
    return null;
  }

  if (row.pendingOp !== null && row.pendingOp.kind === 'calendar_repair') {
    if (!isStaleOp(row.pendingOp, ctx.clock.now())) {
      throw new OperationInProgressError(retryAfterSeconds(row.pendingOp, ctx.clock.now()));
    }
    // Notify takes over a stale repair and resumes it (REV4-04). Staleness is
    // re-decided against the generation on the row under the lock, so a second
    // notify cannot steal the generation a first one just established (C6.3).
    const acquired = await acquireStaleOp(ctx, row, ['calendar_repair']);
    if (acquired.state === 'busy') {
      throw new OperationInProgressError(acquired.retryAfterSeconds);
    }
    if (acquired.state === 'gone') {
      throw new OperationInProgressError(1);
    }
    return runRepair(ctx, acquired.row, acquired.op, request);
  }

  if (row.calendarState !== 'failed' || row.pendingOp !== null) {
    return null;
  }

  const opId = newOperationId();
  const eventId = row.googleEventId;
  if (eventId === null) {
    return null;
  }

  const started = await ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (
      fresh === null ||
      fresh.status !== 'confirmed' ||
      fresh.calendarState !== 'failed' ||
      fresh.pendingOp !== null
    ) {
      return null;
    }
    const op = beginOp('calendar_repair', ctx.clock, { opId, eventId });
    const ok = await tx.update({
      id: fresh.id,
      expectedRevision: fresh.revision,
      patch: { pendingOp: op },
    });
    return ok ? op : null;
  });
  if (started === null) {
    return null;
  }

  const withOp = (await ctx.store.getById(row.id)) ?? row;
  return runRepair(ctx, withOp, started, request);
}

export async function runRepair(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
  request: RepairRequest,
): Promise<RepairOutcome> {
  const eventId = op.eventId as string;
  const observed = await observeId(ctx, row.id, eventId);
  if (unobserved(observed)) {
    // Refused reads are not absence; repairing blind could duplicate the event.
    throw new BookingOutcomeUnknownError();
  }

  let etag: string | null = null;
  /** This worker's own insert, when it issued one that definitely applied. */
  let ownInsert: { attemptId: string; eventId: string; etag: string } | null = null;
  if (observed.state === 'present') {
    // Adopt the existing event; zero inserts.
    etag = observed.event.etag;
  } else {
    const attempt = newAttempt('insert', eventId, op.gen, ctx.clock);
    if (!(await writeAttempt(ctx, row, op, attempt))) {
      throw new OperationInProgressError(1);
    }
    try {
      const event = await ctx.calendar.insert({
        calendarId: ctx.calendarId,
        id: eventId,
        start: row.start,
        end: row.end,
        summary: request.eventName,
        bookingId: row.id,
        attemptId: attempt.attemptId,
        sendUpdates: ctx.sendUpdates,
        ...(ctx.sendUpdates === 'all'
          ? {
              attendees: [
                { email: request.invitee.email, displayName: request.invitee.name },
              ],
            }
          : {}),
      });
      const verified = await verifyInsert(ctx, row.id, eventId, event);
      if (verified.state !== 'present') {
        // An unverifiable 2xx completes nothing (C6.2, REVIEW-05).
        throw new BookingOutcomeUnknownError();
      }
      await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
      etag = verified.event.etag;
      // A definite 2xx is the one thing that resolves THIS attempt (C6.3b), so
      // it is also the only response that may later enter the C6.3a cleanup.
      ownInsert = { attemptId: attempt.attemptId, eventId, etag: verified.event.etag };
    } catch (error) {
      if (error instanceof BookingOutcomeUnknownError) {
        throw error;
      }
      const klass = classifyCalendarError(error);
      if (klass === 'already_exists') {
        await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
        const again = await observeId(ctx, row.id, eventId);
        if (again.state === 'present') {
          etag = again.event.etag;
        } else if (unobserved(again)) {
          // A 409 says only that THIS request created nothing; the op is decided
          // by `events.get` (C6.2). A refused or ambiguous read (403, 429, a
          // timeout) established neither presence nor absence, so the repair may
          // not be written off as failed — `pending_op` stays owned and the next
          // notify resolves it (C6.0/C6.8 — LIVE-REVIEW-13).
          throw new BookingOutcomeUnknownError();
        } else {
          // Definitely absent: the repair really did not happen (T2′).
          await clearRepair(ctx, row, op);
          return { calendarState: 'failed', row: (await ctx.store.getById(row.id)) ?? row };
        }
      } else if (klass === OUTCOME_DEFINITE) {
        await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
        // T2′: `calendar_state` stays `failed`; emails are still retried.
        await clearRepair(ctx, row, op);
        return { calendarState: 'failed', row: (await ctx.store.getById(row.id)) ?? row };
      } else {
        // Ambiguous: `pending_op` retained, resolved by the next notify.
        throw new BookingOutcomeUnknownError();
      }
    }
  }

  // C6.5 — repair T2 is a completing transaction like every other, so a lost
  // `COMMIT` response must be reconciled on a fresh connection after the host
  // lock is reacquired, not thrown as an unstructured error (REV-05).
  const settled = await settleCompletion(
    ctx,
    row,
    () => repairT2(ctx, row, op, etag),
    // The repair committed iff the calendar is `created` and its op is cleared.
    (fresh) =>
      fresh !== null &&
      fresh.calendarState === 'created' &&
      (fresh.pendingOp === null || fresh.pendingOp.opId !== op.opId),
  );
  if (settled.kind === 'reconciled') {
    return { calendarState: 'created', row: settled.row };
  }
  if (settled.kind === 'failed') {
    // Known not to have committed: `pending_op` retained, NO compensation — the
    // inserted event is the booking's intended event. Next notify resumes at T2.
    throw new RepairFailedError();
  }
  const completed = settled.value;

  if (completed === 'superseded') {
    // C6.3a — a superseded repair reconciles like every other worker, and its
    // own attributed insert is cleaned up when the locked read shows the id
    // retired with that attempt still retained. Throwing `repair_failed` here
    // without that decision left the retired event on the host's calendar.
    const decision = await reconcileSuperseded(
      ctx,
      {
        kind: 'calendar_repair',
        op,
        bookingId: row.id,
        ...(ownInsert === null
          ? {}
          : { ownInsert: { attemptId: ownInsert.attemptId, eventId: ownInsert.eventId } }),
      },
      row.hostId,
    );
    if (decision.eligible && ownInsert !== null) {
      await cleanupOwnEvent(ctx, row.id, ownInsert.eventId, ownInsert.attemptId, ownInsert.etag);
    }
    if (decision.response === 'operation_in_progress') {
      throw new OperationInProgressError(decision.retryAfterSeconds ?? 1);
    }
    if (decision.response === 'success' && decision.row !== null) {
      // The winner repaired it; report that outcome rather than a failure.
      return { calendarState: 'created', row: decision.row };
    }
    throw new RepairFailedError();
  }
  if (completed === 'failed') {
    // T2 failure while still the owner: `pending_op` retained, NO compensation —
    // the inserted event is the booking's intended event. Next notify resumes.
    throw new RepairFailedError();
  }
  return { calendarState: 'created', row: (await ctx.store.getById(row.id)) ?? row };
}

type RepairT2 = 'ok' | 'failed' | 'superseded';

async function repairT2(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
  etag: string | null,
): Promise<RepairT2> {
  return ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null) {
      return 'superseded';
    }
    if (fresh.pendingOp.opId !== op.opId || fresh.pendingOp.gen !== op.gen) {
      return 'superseded';
    }
    const retained = retainedFrom(fresh.unresolvedInserts, fresh.pendingOp.attempts);
    const ok = await tx.update({
      id: row.id,
      expectedRevision: fresh.revision,
      requireConfirmed: true,
      opId: op.opId,
      gen: op.gen,
      patch: {
        calendarState: 'created',
        googleEventEtag: etag,
        pendingOp: null,
        // Repair removes NOTHING from the retained list (REV5-02).
        unresolvedInserts: retained,
      },
    });
    return ok ? 'ok' : 'failed';
  });
}

/**
 * Repair T2′ — clears the op after a definite insert failure. It is a clearing
 * transaction, so a lost `COMMIT` response goes through C6.5 too: an outcome
 * that cannot be established leaves `pending_op` owned and answers 503
 * `booking_outcome_unknown` rather than escaping untyped (REV-05).
 */
async function clearRepair(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
): Promise<void> {
  const settled = await settleCompletion(
    ctx,
    row,
    () =>
      ctx.store.withHostLock(row.hostId, async (tx) => {
        const fresh = await tx.selectForUpdate(row.id);
        if (fresh === null || fresh.pendingOp === null) {
          return;
        }
        const retained = retainedFrom(fresh.unresolvedInserts, fresh.pendingOp.attempts);
        await tx.update({
          id: row.id,
          expectedRevision: fresh.revision,
          opId: op.opId,
          gen: op.gen,
          patch: { pendingOp: null, unresolvedInserts: retained },
        });
      }),
    // Cleared iff this op no longer owns the row.
    (fresh) => fresh !== null && (fresh.pendingOp === null || fresh.pendingOp.opId !== op.opId),
  );
  if (settled.kind === 'failed') {
    // The clear is known not to have committed: the op stays owned and the next
    // notify resumes it. Nothing is compensated.
    throw new RepairFailedError();
  }
}
