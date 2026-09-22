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
  beginOp,
  finishAttempt,
  newAttempt,
  observeId,
  takeOverOp,
  writeAttempt,
  classifyCalendarError,
  OUTCOME_DEFINITE,
  type LifecycleContext,
} from './ops';
import { isStaleOp, retainedFrom, retryAfterSeconds, type BookingRow, type PendingOp } from './rows';

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
    // Notify takes over a stale repair and resumes it (REV4-04).
    const taken = await ctx.store.withHostLock(row.hostId, async (tx) => {
      const fresh = await tx.selectForUpdate(row.id);
      if (
        fresh === null ||
        fresh.pendingOp === null ||
        fresh.pendingOp.kind !== 'calendar_repair'
      ) {
        return null;
      }
      return takeOverOp(tx, fresh, fresh.pendingOp, ctx.clock);
    });
    if (taken === null) {
      throw new OperationInProgressError(1);
    }
    return runRepair(ctx, row, taken, request);
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
  if (observed.state === 'ambiguous') {
    throw new BookingOutcomeUnknownError();
  }

  let etag: string | null = null;
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
      await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
      etag = event.etag;
    } catch (error) {
      const klass = classifyCalendarError(error);
      if (klass === 'already_exists') {
        await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
        const again = await observeId(ctx, row.id, eventId);
        if (again.state === 'present') {
          etag = again.event.etag;
        } else {
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

  const completed = await ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null) {
      return false;
    }
    const retained = retainedFrom(fresh.unresolvedInserts, fresh.pendingOp.attempts);
    return tx.update({
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
  });
  if (!completed) {
    // T2 failure: `pending_op` retained, NO compensation — the inserted event
    // is the booking's intended event. The next notify resumes at T2.
    throw new RepairFailedError();
  }
  return { calendarState: 'created', row: (await ctx.store.getById(row.id)) ?? row };
}

async function clearRepair(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
): Promise<void> {
  await ctx.store.withHostLock(row.hostId, async (tx) => {
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
  });
}
