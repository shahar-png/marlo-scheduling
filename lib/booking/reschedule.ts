// C6.6 — reschedule.
//
// T1 reserves the destination durably and records the op (so the slot is held
// from the moment the transaction commits, not from the moment Google answers);
// the calendar step patches the live event, or inserts under the durable
// `fallbackEventId` when the patch 404s; T2 releases the reservation and
// advances the revision.
//
// A stale op taken over here is reconciled **against the request** (REV7-03):
//   (i)   same-target recovery — the completed move *is* this request → 200
//         with that outcome, no second operation, no availability check;
//   (ii)  different target — 409 `booking_changed`, the reconciliation stands;
//   (iii) abandoned, or a create/repair → proceed as a new op.
// A move that happened is therefore never answered `slot_unavailable`.

import { AvailabilityUnknownError } from '../google/errors';
import {
  AvailabilityUnknownResponse,
  BookingChangedError,
  BookingOutcomeUnknownError,
  CalendarPatchFailedError,
  OperationInProgressError,
  OperationSupersededError,
  RescheduleFailedError,
  SlotUnavailableError,
} from './errors';
import { bookingBody, buildEnvelope, type BookingEnvelope, type EnvelopeMeta } from './envelope';
import { newCalendarEventId, newOperationId } from './ids';
import { busyOverlaps, externalBusy } from './occupancy';
import {
  beginOp,
  bumpVersion,
  finishAttempt,
  newAttempt,
  observeId,
  takeOverOp,
  writeAttempt,
  classifyCalendarError,
  OUTCOME_DEFINITE,
  SupersededError,
  type LifecycleContext,
} from './ops';
import { hasEligibleReap, reapRetiredIds } from './reap';
import {
  isStaleOp,
  retainedFrom,
  retryAfterSeconds,
  type BookingRow,
  type Interval,
  type PendingOp,
} from './rows';
import { cleanupOwnEvent, reconcileSuperseded } from './superseded';

export type RescheduleRequest = {
  bookingId: string;
  start: string;
  expectedRevision: number;
  durationMinutes: number;
  eventName: string;
  invitee: { name: string; email: string };
  timeZone?: string;
};

export type RescheduleDeps = {
  ctx: LifecycleContext;
  meta: EnvelopeMeta;
  notify: (row: BookingRow, previousStart: string) => Promise<void>;
  /** Completes an inherited create/repair op before this reschedule begins. */
  completeInherited: (row: BookingRow, op: PendingOp) => Promise<void>;
  hooks?: {
    afterT1?: () => Promise<void>;
    afterPatch?: () => Promise<void>;
    beforeT2?: () => Promise<void>;
  };
};

export type RescheduleOutcome = {
  envelope: BookingEnvelope;
  row: BookingRow;
  /** True when the answer came from same-target recovery (REV7-03). */
  recovered: boolean;
};

export async function rescheduleDurableBooking(
  deps: RescheduleDeps,
  request: RescheduleRequest,
  /** @internal — one re-entry only, after a stale op was reconciled (iii). */
  pass = 0,
): Promise<RescheduleOutcome> {
  const { ctx } = deps;
  if (pass > 1) {
    throw new OperationInProgressError(1);
  }
  const existing = await ctx.store.getById(request.bookingId);
  if (existing === null) {
    throw new BookingChangedError();
  }

  // C6.3a reap of this row's retired ids — bounded cleanup, never a precondition.
  if (hasEligibleReap(existing)) {
    await reapRetiredIds(ctx, existing.id);
  }

  const window = intervalFor(request);

  // R0 — external read BEFORE T1, outside any transaction (REV6-03), with the
  // booking's own managed event excluded.
  let external: Interval[];
  try {
    external = await externalBusy(ctx, {
      window,
      excludeBookingId: existing.id,
      ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
    });
  } catch (error) {
    if (error instanceof AvailabilityUnknownError) {
      throw new AvailabilityUnknownResponse();
    }
    throw error;
  }
  if (busyOverlaps(window, external)) {
    // Nothing written, no op, no reservation, zero mutations.
    throw new SlotUnavailableError();
  }

  const opId = newOperationId();
  const fallbackEventId = newCalendarEventId();

  const t1 = await ctx.store.withHostLock(existing.hostId, async (tx) => {
    const row = await tx.selectForUpdate(request.bookingId);
    if (row === null) {
      return { kind: 'gone' as const };
    }
    if (row.status !== 'confirmed' || row.revision !== request.expectedRevision) {
      return { kind: 'changed' as const, row };
    }

    if (row.pendingOp !== null) {
      const op = row.pendingOp;
      if (op.kind === 'cancel') {
        // A stale cancel is resumed only by a cancel call.
        return { kind: 'busy' as const, row, op };
      }
      if (!isStaleOp(op, ctx.clock.now())) {
        return { kind: 'busy' as const, row, op };
      }
      const taken = await takeOverOp(tx, row, op, ctx.clock);
      if (taken === null) {
        return { kind: 'raced' as const, row };
      }
      return { kind: 'tookOver' as const, row, op: taken };
    }

    // C6.1: the locked occupancy re-check, excluding this booking's own.
    const managed = await tx.occupancy({
      hostId: row.hostId,
      window,
      excludeBookingId: row.id,
    });
    if (busyOverlaps(window, managed)) {
      return { kind: 'unavailable' as const, row };
    }

    const op = beginOp('reschedule', ctx.clock, {
      opId,
      newStart: window.start,
      newEnd: window.end,
      ...(row.googleEventId === null ? {} : { oldEventId: row.googleEventId }),
      fallbackEventId,
      ...(row.googleEventEtag === null ? {} : { etag: row.googleEventEtag }),
    });
    const ok = await tx.update({
      id: row.id,
      expectedRevision: row.revision,
      patch: {
        pendingOp: op,
        // The destination is reserved durably in T1 (C6.1).
        reservedStart: window.start,
        reservedEnd: window.end,
      },
    });
    if (!ok) {
      return { kind: 'changed' as const, row };
    }
    return { kind: 'started' as const, row, op };
  });

  if (t1.kind === 'gone') {
    throw new BookingChangedError();
  }
  if (t1.kind === 'changed') {
    throw new BookingChangedError(bookingBody(t1.row, deps.meta));
  }
  if (t1.kind === 'unavailable') {
    throw new SlotUnavailableError();
  }
  if (t1.kind === 'raced') {
    throw new OperationInProgressError(1);
  }
  if (t1.kind === 'busy') {
    throw new OperationInProgressError(retryAfterSeconds(t1.op, ctx.clock.now()));
  }

  if (t1.kind === 'tookOver') {
    const reconciled = await reconcileStale(deps, request, t1.row, t1.op);
    if (reconciled !== null) {
      return reconciled;
    }
    // (iii) proceed as a new op under the caller's expectedRevision.
    return rescheduleDurableBooking(deps, request, pass + 1);
  }

  await deps.hooks?.afterT1?.();
  return runRescheduleCalendarStep(deps, request, t1.row, t1.op);
}

/**
 * C6.6 (i)/(ii)/(iii). Returns the recovered outcome for (i), throws for (ii),
 * and returns `null` for (iii) — "proceed as a new op".
 */
async function reconcileStale(
  deps: RescheduleDeps,
  request: RescheduleRequest,
  row: BookingRow,
  op: PendingOp,
): Promise<RescheduleOutcome | null> {
  const { ctx } = deps;

  if (op.kind === 'create' || op.kind === 'calendar_repair') {
    // Always completed, never abandoned (C6.4a): completing changes neither
    // `start` nor `revision`, so this reschedule proceeds as a new op.
    await deps.completeInherited(row, op);
    return null;
  }

  // A stale reschedule: bump the predecessor's version first (C6.3c).
  const targetId = op.oldEventId ?? row.googleEventId;
  if (targetId !== null && targetId !== undefined) {
    const bumped = await bumpVersion(ctx, row, op, targetId);
    if (bumped.state === 'ambiguous') {
      throw new BookingOutcomeUnknownError();
    }
  }

  const observedOld =
    targetId === null || targetId === undefined
      ? { state: 'absent' as const }
      : await observeId(ctx, row.id, targetId);
  const observedFallback =
    op.fallbackEventId === undefined
      ? { state: 'absent' as const }
      : await observeId(ctx, row.id, op.fallbackEventId);

  if (observedOld.state === 'ambiguous' || observedFallback.state === 'ambiguous') {
    throw new BookingOutcomeUnknownError();
  }

  const movedToTarget =
    observedOld.state === 'present' && observedOld.event.start === op.newStart;
  const fallbackInserted = observedFallback.state === 'present';

  if (movedToTarget || fallbackInserted) {
    // The predecessor achieved its move: complete it through its own T2.
    const resultingId = fallbackInserted
      ? (op.fallbackEventId as string)
      : (targetId as string);
    const etag = fallbackInserted
      ? (observedFallback.state === 'present' ? observedFallback.event.etag : null)
      : observedOld.state === 'present'
        ? observedOld.event.etag
        : null;
    const completed = await completeReschedule(deps, row, op, resultingId, etag);
    if (completed.superseded) {
      throw new OperationInProgressError(1);
    }
    await deps.notify(completed.row, row.start);

    const fresh = (await ctx.store.getById(row.id)) ?? completed.row;
    if (op.newStart === intervalFor(request).start) {
      // (i) same-target recovery: the completed move IS this request.
      return {
        envelope: await buildEnvelope(ctx.store, fresh, deps.meta, 'lifecycle'),
        row: fresh,
        recovered: true,
      };
    }
    // (ii) different target: the reconciliation stands.
    throw new BookingChangedError(bookingBody(fresh, deps.meta));
  }

  // Nothing achieved → abandon via T2′, retaining any outstanding fallback id.
  await abandonReschedule(deps, row, op);
  return null;
}

async function runRescheduleCalendarStep(
  deps: RescheduleDeps,
  request: RescheduleRequest,
  row: BookingRow,
  op: PendingOp,
): Promise<RescheduleOutcome> {
  const { ctx } = deps;
  const oldEventId = op.oldEventId;
  let resultingId: string | null = null;
  let etag: string | null = null;
  let ownInsert: { eventId: string; attemptId: string; etag: string } | null = null;

  if (oldEventId !== undefined && op.etag !== undefined) {
    const attempt = newAttempt('patch', oldEventId, op.gen, ctx.clock, op.etag);
    if (!(await writeAttempt(ctx, row, op, attempt))) {
      return supersededReschedule(deps, request, row, op, null);
    }
    try {
      const patched = await ctx.calendar.patch({
        calendarId: ctx.calendarId,
        eventId: oldEventId,
        start: op.newStart,
        end: op.newEnd,
        summary: request.eventName,
        ifMatch: op.etag,
        sendUpdates: ctx.sendUpdates,
      });
      await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
      resultingId = oldEventId;
      etag = patched.etag;
    } catch (error) {
      const klass = classifyCalendarError(error);
      if (klass === 'precondition_failed') {
        await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
        const reconciled = await reconcilePrecondition(deps, request, row, op, oldEventId);
        if (reconciled === null) {
          await failReschedule(deps, row, op);
          throw new CalendarPatchFailedError();
        }
        resultingId = oldEventId;
        etag = reconciled;
      } else if (klass === OUTCOME_DEFINITE) {
        await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
        // 404/410 on patch → insert the replacement under the durable fallback id.
        const inserted = await insertFallback(deps, request, row, op);
        if (inserted === null) {
          await failReschedule(deps, row, op);
          throw new CalendarPatchFailedError();
        }
        if (inserted === 'superseded') {
          return supersededReschedule(deps, request, row, op, null);
        }
        resultingId = inserted.eventId;
        etag = inserted.etag;
        ownInsert = inserted;
      } else {
        // Ambiguous: `pending_op` and the reservation are retained.
        throw new BookingOutcomeUnknownError();
      }
    }
  } else {
    const inserted = await insertFallback(deps, request, row, op);
    if (inserted === null) {
      await failReschedule(deps, row, op);
      throw new CalendarPatchFailedError();
    }
    if (inserted === 'superseded') {
      return supersededReschedule(deps, request, row, op, null);
    }
    resultingId = inserted.eventId;
    etag = inserted.etag;
    ownInsert = inserted;
  }

  await deps.hooks?.afterPatch?.();
  await deps.hooks?.beforeT2?.();

  const completed = await completeReschedule(deps, row, op, resultingId, etag);
  if (completed.superseded) {
    return supersededReschedule(deps, request, row, op, ownInsert);
  }
  await deps.notify(completed.row, row.start);
  const fresh = (await ctx.store.getById(row.id)) ?? completed.row;
  return {
    envelope: await buildEnvelope(ctx.store, fresh, deps.meta, 'lifecycle'),
    row: fresh,
    recovered: false,
  };
}

async function insertFallback(
  deps: RescheduleDeps,
  request: RescheduleRequest,
  row: BookingRow,
  op: PendingOp,
): Promise<{ eventId: string; attemptId: string; etag: string } | null | 'superseded'> {
  const { ctx } = deps;
  const eventId = op.fallbackEventId as string;
  const attempt = newAttempt('insert', eventId, op.gen, ctx.clock);
  // The attempt write doubles as the ownership re-check (C6.3): a superseded
  // worker never reaches Google.
  if (!(await writeAttempt(ctx, row, op, attempt))) {
    return 'superseded';
  }
  try {
    const event = await ctx.calendar.insert({
      calendarId: ctx.calendarId,
      id: eventId,
      start: op.newStart as string,
      end: op.newEnd as string,
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
    return { eventId, attemptId: attempt.attemptId, etag: event.etag };
  } catch (error) {
    const klass = classifyCalendarError(error);
    if (klass === 'already_exists') {
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      const observed = await observeId(ctx, row.id, eventId);
      if (observed.state === 'present') {
        return { eventId, attemptId: attempt.attemptId, etag: observed.event.etag };
      }
      return null;
    }
    if (klass === OUTCOME_DEFINITE) {
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      return null;
    }
    throw new BookingOutcomeUnknownError();
  }
}

/** C6.3c — 412 is reconciliation, never a blind retry. */
async function reconcilePrecondition(
  deps: RescheduleDeps,
  request: RescheduleRequest,
  row: BookingRow,
  op: PendingOp,
  eventId: string,
): Promise<string | null> {
  const { ctx } = deps;
  const observed = await observeId(ctx, row.id, eventId);
  if (observed.state === 'ambiguous') {
    throw new BookingOutcomeUnknownError();
  }
  if (observed.state === 'absent') {
    return null;
  }
  // (i) already at this op's target → treat as applied.
  if (observed.event.start === op.newStart) {
    return observed.event.etag;
  }
  // (ii) the expected pre-state with a different etag → exactly one retry.
  if (observed.event.start === row.start) {
    const retry = newAttempt('patch', eventId, op.gen, ctx.clock, observed.event.etag);
    if (!(await writeAttempt(ctx, row, op, retry))) {
      throw new SupersededError(row.id);
    }
    try {
      const patched = await ctx.calendar.patch({
        calendarId: ctx.calendarId,
        eventId,
        start: op.newStart,
        end: op.newEnd,
        summary: request.eventName,
        ifMatch: observed.event.etag,
        sendUpdates: ctx.sendUpdates,
      });
      await finishAttempt(ctx, row, op, retry.attemptId, 'applied');
      return patched.etag;
    } catch (error) {
      const klass = classifyCalendarError(error);
      if (klass === OUTCOME_DEFINITE || klass === 'precondition_failed') {
        await finishAttempt(ctx, row, op, retry.attemptId, 'rejected');
        return null;
      }
      throw new BookingOutcomeUnknownError();
    }
  }
  // (iii) a host-edited interval or a foreign change → definite failure.
  return null;
}

async function completeReschedule(
  deps: RescheduleDeps,
  row: BookingRow,
  op: PendingOp,
  resultingId: string | null,
  etag: string | null,
): Promise<{ superseded: boolean; row: BookingRow }> {
  const { ctx } = deps;
  const result = await ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null) {
      return { superseded: true, row: fresh ?? row };
    }
    const retained = retainedFrom(fresh.unresolvedInserts, fresh.pendingOp.attempts);
    const ok = await tx.update({
      id: row.id,
      expectedRevision: fresh.revision,
      opId: op.opId,
      gen: op.gen,
      patch: {
        start: op.newStart as string,
        end: op.newEnd as string,
        rescheduledFrom: fresh.start,
        ...(resultingId === null ? {} : { googleEventId: resultingId }),
        googleEventEtag: etag,
        calendarState: 'created',
        bumpRevision: true,
        latestAction: 'reschedule',
        pendingOp: null,
        reservedStart: null,
        reservedEnd: null,
        unresolvedInserts: retained,
      },
    });
    return { superseded: !ok, row: fresh };
  });
  if (result.superseded) {
    return result;
  }
  return { superseded: false, row: (await ctx.store.getById(row.id)) ?? result.row };
}

/** T2′ — abandons the op, releases the reservation, retains outstanding ids. */
async function abandonReschedule(
  deps: RescheduleDeps,
  row: BookingRow,
  op: PendingOp,
): Promise<void> {
  await deps.ctx.store.withHostLock(row.hostId, async (tx) => {
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
      patch: {
        pendingOp: null,
        reservedStart: null,
        reservedEnd: null,
        unresolvedInserts: retained,
      },
    });
  });
}

async function failReschedule(
  deps: RescheduleDeps,
  row: BookingRow,
  op: PendingOp,
): Promise<void> {
  await abandonReschedule(deps, row, op);
}

async function supersededReschedule(
  deps: RescheduleDeps,
  request: RescheduleRequest,
  row: BookingRow,
  op: PendingOp,
  ownInsert: { eventId: string; attemptId: string; etag: string } | null,
): Promise<RescheduleOutcome> {
  const decision = await reconcileSuperseded(deps.ctx, {
    kind: 'reschedule',
    op,
    bookingId: row.id,
    target: op.newStart as string,
  });

  if (decision.eligible && ownInsert !== null) {
    await cleanupOwnEvent(
      deps.ctx,
      row.id,
      ownInsert.eventId,
      ownInsert.attemptId,
      ownInsert.etag,
    );
  }

  if (decision.response === 'success' && decision.row !== null) {
    return {
      envelope: await buildEnvelope(deps.ctx.store, decision.row, deps.meta, 'lifecycle'),
      row: decision.row,
      recovered: true,
    };
  }
  if (decision.response === 'operation_in_progress') {
    throw new OperationInProgressError(decision.retryAfterSeconds ?? 1);
  }
  throw new OperationSupersededError(
    decision.row === null ? undefined : bookingBody(decision.row, deps.meta),
  );
}

export function intervalFor(request: {
  start: string;
  durationMinutes: number;
}): Interval {
  const startMs = Date.parse(request.start);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + request.durationMinutes * 60_000).toISOString(),
  };
}

export { RescheduleFailedError };
