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
  failAttempt,
  finishAttempt,
  newAttempt,
  observeId,
  takeOverOp,
  unobserved,
  verifyInsert,
  writeAttempt,
  classifyCalendarError,
  OUTCOME_DEFINITE,
  SupersededError,
  type LifecycleContext,
} from './ops';
import { isAbsenceStatus } from '../google/errors';
import { hasEligibleReap, reapRetiredIds } from './reap';
import { settleCompletion } from './settle';
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

  // The existing operation is inspected and reconciled **before** any external
  // read (REVIEW-03). C6.6(i) recovery of a move that already happened needs no
  // availability at all, so running R0 first could answer a same-target retry
  // `slot_unavailable` (an external event now overlaps the target) or
  // `availability_unknown` (`events.list` is down) for a reschedule that is
  // already applied at Google and only needs its T2.
  const inspected = await ctx.store.withHostLock(existing.hostId, async (tx) => {
    const row = await tx.selectForUpdate(request.bookingId);
    if (row === null) {
      return { kind: 'gone' as const };
    }
    if (row.status !== 'confirmed' || row.revision !== request.expectedRevision) {
      return { kind: 'changed' as const, row };
    }
    if (row.pendingOp === null) {
      return { kind: 'clear' as const };
    }
    const op = row.pendingOp;
    if (op.kind === 'cancel' || !isStaleOp(op, ctx.clock.now())) {
      // A stale cancel is resumed only by a cancel call.
      return { kind: 'busy' as const, row, op };
    }
    const taken = await takeOverOp(tx, row, op, ctx.clock);
    if (taken === null) {
      return { kind: 'raced' as const };
    }
    return { kind: 'tookOver' as const, row, op: taken };
  });

  if (inspected.kind === 'gone') {
    throw new BookingChangedError();
  }
  if (inspected.kind === 'changed') {
    throw new BookingChangedError(bookingBody(inspected.row, deps.meta));
  }
  if (inspected.kind === 'raced') {
    throw new OperationInProgressError(1);
  }
  if (inspected.kind === 'busy') {
    throw new OperationInProgressError(retryAfterSeconds(inspected.op, ctx.clock.now()));
  }
  if (inspected.kind === 'tookOver') {
    const reconciled = await reconcileStale(deps, request, inspected.row, inspected.op);
    if (reconciled !== null) {
      return reconciled;
    }
    // (iii) proceed as a new op under the caller's expectedRevision — and only
    // now does the new move need availability.
    return rescheduleDurableBooking(deps, request, pass + 1);
  }

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

  if (unobserved(observedOld) || unobserved(observedFallback)) {
    // Neither completion nor abandonment is permitted on a read that
    // established nothing (C6.0): the op stays owned.
    throw new BookingOutcomeUnknownError();
  }

  // C6.3c — the bump covers **every** intended event this takeover found, not
  // just `oldEventId`. A predecessor that fallback-inserted F and then paused
  // before its compensating delete still holds F's insert etag; adopting F
  // without invalidating that version lets the delayed delete land on the event
  // this takeover is about to make the booking's own (LIVE-REVIEW-04).
  let fallbackEtag: string | null =
    observedFallback.state === 'present' ? observedFallback.event.etag : null;
  let fallbackInserted = observedFallback.state === 'present';
  if (fallbackInserted && op.fallbackEventId !== undefined) {
    const bumpedFallback = await bumpVersion(ctx, row, op, op.fallbackEventId);
    if (bumpedFallback.state === 'ambiguous') {
      throw new BookingOutcomeUnknownError();
    }
    if (bumpedFallback.state === 'absent') {
      // It went away between the two reads; nothing was achieved through it.
      fallbackInserted = false;
      fallbackEtag = null;
    } else {
      fallbackEtag = bumpedFallback.etag;
    }
  }

  const movedToTarget =
    observedOld.state === 'present' && observedOld.event.start === op.newStart;

  if (movedToTarget || fallbackInserted) {
    // The predecessor achieved its move: complete it through its own T2.
    const resultingId = fallbackInserted
      ? (op.fallbackEventId as string)
      : (targetId as string);
    const etag = fallbackInserted
      ? fallbackEtag
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

  // C6.3c: when the row carries an event id but no etag (a row created before
  // the column, or one whose create left `calendar_state='failed'` while an
  // ambiguous insert could still land), the op **observes** the id and records
  // the etag before mutating. Falling straight through to `insertFallback`
  // duplicates an event that is actually there (REVIEW-04).
  let patchEtag = op.etag;
  if (oldEventId !== undefined && patchEtag === undefined) {
    const observed = await observeId(ctx, row.id, oldEventId);
    if (unobserved(observed)) {
      // A refused or ambiguous read is not absence: the op stays owned.
      throw new BookingOutcomeUnknownError();
    }
    if (observed.state === 'present') {
      patchEtag = observed.event.etag;
    }
  }

  if (oldEventId !== undefined && patchEtag !== undefined) {
    const attempt = newAttempt('patch', oldEventId, op.gen, ctx.clock, patchEtag);
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
        ifMatch: patchEtag,
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
      } else if (klass === OUTCOME_DEFINITE && !isAbsenceStatus(error)) {
        // A definite refusal that is NOT 404/410 (401, 403, 400, 422,
        // `host_not_connected`) says the patch did nothing — it does **not**
        // say the event is gone. Inserting a fallback here would duplicate a
        // live event, so the reschedule fails and the booking is untouched.
        await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
        await failReschedule(deps, row, op);
        throw new CalendarPatchFailedError();
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

  const completed = await completeReschedule(deps, row, op, resultingId, etag, {
    resultingId,
    etag,
    ownInsert,
  });
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
    const verified = await verifyInsert(ctx, row.id, eventId, event);
    if (verified.state !== 'present') {
      // An unverifiable 2xx completes nothing (C6.2, REVIEW-05): the attempt
      // stays unresolved and the op is retained.
      throw new BookingOutcomeUnknownError();
    }
    await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
    return { eventId, attemptId: attempt.attemptId, etag: verified.event.etag };
  } catch (error) {
    if (error instanceof BookingOutcomeUnknownError) {
      throw error;
    }
    const klass = classifyCalendarError(error);
    if (klass === 'already_exists') {
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      const observed = await observeId(ctx, row.id, eventId);
      if (observed.state === 'present') {
        return { eventId, attemptId: attempt.attemptId, etag: observed.event.etag };
      }
      if (unobserved(observed)) {
        throw new BookingOutcomeUnknownError();
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
  if (unobserved(observed)) {
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
  /** What this worker changed at Google, for the compensation C6.6 owes. */
  applied?: { resultingId: string | null; etag: string | null; ownInsert: OwnInsert | null },
): Promise<{ superseded: boolean; row: BookingRow }> {
  const { ctx } = deps;
  const settled = await settleCompletion(
    ctx,
    row,
    () => completeRescheduleTx(deps, row, op, resultingId, etag),
    // The move committed iff the revision advanced past the one T2 conditioned
    // on and the row now sits at this op's target.
    (fresh) =>
      fresh !== null && fresh.start === op.newStart && fresh.revision > row.revision,
  );
  if (settled.kind === 'reconciled') {
    return { superseded: false, row: settled.row };
  }
  if (settled.kind === 'failed') {
    // The transaction is known to have rolled back: Google is at the new time
    // and the row at the old one, so this worker undoes its own mutation —
    // ownership-checked and ETag-conditioned (C6.6).
    if (applied !== undefined) {
      await compensateReschedule(deps, row, op, applied);
    }
    throw new RescheduleFailedError();
  }
  return settled.value;
}

type OwnInsert = { eventId: string; attemptId: string; etag: string };

/**
 * C6.6 compensation after a **definite** T2 failure: patch the event back to
 * the old time with the etag this worker's own patch returned, or delete the
 * fallback it inserted with the etag that insert returned. Both are preceded by
 * an attempt write that re-verifies ownership, and a 412 means a takeover has
 * already invalidated this worker's version — zero further mutations (C6.3c).
 */
async function compensateReschedule(
  deps: RescheduleDeps,
  row: BookingRow,
  op: PendingOp,
  applied: { resultingId: string | null; etag: string | null; ownInsert: OwnInsert | null },
): Promise<void> {
  const { ctx } = deps;

  if (applied.ownInsert !== null) {
    const attempt = newAttempt(
      'delete',
      applied.ownInsert.eventId,
      op.gen,
      ctx.clock,
      applied.ownInsert.etag,
    );
    if (!(await writeAttempt(ctx, row, op, attempt))) {
      return; // superseded: the winner owns the event now.
    }
    try {
      await ctx.calendar.remove({
        calendarId: ctx.calendarId,
        eventId: applied.ownInsert.eventId,
        ifMatch: applied.ownInsert.etag,
        sendUpdates: 'none',
      });
      await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
    } catch (error) {
      // 412 or a definite refusal resolves this attempt; a 429/5xx/timeout
      // leaves it `unresolved`, because the delete may still execute and the id
      // must stay reapable (C6.0/C6.3b — LIVE-REVIEW-05).
      await failAttempt(ctx, row, op, attempt.attemptId, error);
    }
    return;
  }

  const eventId = applied.resultingId;
  if (eventId === null || applied.etag === null || op.oldEventId !== eventId) {
    return;
  }
  const attempt = newAttempt('patch', eventId, op.gen, ctx.clock, applied.etag);
  if (!(await writeAttempt(ctx, row, op, attempt))) {
    return;
  }
  try {
    await ctx.calendar.patch({
      calendarId: ctx.calendarId,
      eventId,
      start: row.start,
      end: row.end,
      ifMatch: applied.etag,
      sendUpdates: 'none',
    });
    await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
  } catch (error) {
    // Same rule: an ambiguous compensating patch stays unresolved.
    await failAttempt(ctx, row, op, attempt.attemptId, error);
  }
}

async function completeRescheduleTx(
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
    if (!ok) {
      return { superseded: true, row: fresh };
    }
    // **This T2's own committed snapshot**, built from the row it conditioned on
    // plus exactly the patch it applied. Re-reading the row afterwards — even
    // under a lock — can only observe whatever committed *last*: a later move's
    // revision, which this worker would then send with its own older
    // `previousStart` (and could claim that move's delivery rows before its own
    // worker does), or a cancel's revision, which `pairIsReal` rejects, dropping
    // this move's notification entirely. Accepted email *arrival* reordering
    // does not extend to wrong revision content (REV-03).
    const committed: BookingRow = {
      ...fresh,
      start: op.newStart as string,
      end: op.newEnd as string,
      rescheduledFrom: fresh.start,
      ...(resultingId === null ? {} : { googleEventId: resultingId }),
      googleEventEtag: etag,
      calendarState: 'created',
      revision: fresh.revision + 1,
      latestAction: 'reschedule',
      pendingOp: null,
      reservedStart: null,
      reservedEnd: null,
      unresolvedInserts: retained,
    };
    return { superseded: false, row: committed };
  });
  return result;
}

/**
 * Completes a **taken-over** reschedule from observed Google state (C6.6/C6.7).
 *
 * A cancel — or another reschedule — that finds a stale reschedule whose move
 * did land must finish it via *its own* T2: `revision + 1`, the resulting event
 * id, and the `(revision, 'reschedule')` emails. Declaring it complete without
 * running that T2 would leave the row at the old revision while the caller
 * continues against `revision + 1`, which is the `booking_changed` C6.7
 * explicitly does not want here.
 */
export async function completeInheritedReschedule(
  deps: RescheduleDeps,
  row: BookingRow,
  op: PendingOp,
): Promise<void> {
  const { ctx } = deps;
  const previousStart = row.start;

  let resultingId: string | null = null;
  let etag: string | null = null;

  if (op.oldEventId !== undefined) {
    const observed = await observeId(ctx, row.id, op.oldEventId);
    if (observed.state === 'present' && observed.event.start === op.newStart) {
      resultingId = op.oldEventId;
      etag = observed.event.etag;
    }
  }
  if (resultingId === null && op.fallbackEventId !== undefined) {
    const observed = await observeId(ctx, row.id, op.fallbackEventId);
    if (observed.state === 'present') {
      resultingId = op.fallbackEventId;
      etag = observed.event.etag;
    }
  }
  if (resultingId === null) {
    // Nothing achieved after all: leave the op to the caller's abandon path.
    return;
  }

  const completed = await completeReschedule(deps, row, op, resultingId, etag);
  if (completed.superseded) {
    return;
  }
  await deps.notify(completed.row, previousStart);
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
  const decision = await reconcileSuperseded(
    deps.ctx,
    {
      kind: 'reschedule',
      op,
      bookingId: row.id,
      target: op.newStart as string,
      // The attempt this worker actually issued: `insertFallback` persists it
      // through `writeAttempt` and never touches the local `op.attempts`, so
      // without this eligibility would read `false` and the retired event would
      // be left behind (REV-02).
      ...(ownInsert === null
        ? {}
        : { ownInsert: { attemptId: ownInsert.attemptId, eventId: ownInsert.eventId } }),
    },
    row.hostId,
  );

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
