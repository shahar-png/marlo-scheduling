// C6.7 — cancel, one policy.
//
// Cancel **never runs concurrently with a reschedule of the same booking and
// never undoes one**: a non-stale op of another kind is refused
// `operation_in_progress` (the token page waits, it does not race), and a stale
// one is taken over, version-bumped, and completed or abandoned from *observed*
// Google state before the cancel proceeds.
//
// The one takeover in this PLAN that replaces a create without completing it —
// a stale create whose event `events.get` found definitely absent — carries that
// create durably in `unfinished_create` (C6.4a), so:
//   * cancel **T2** finalizes it (non-null `latest_action`, marker cleared),
//     which is why the cancelled-booking replay still answers 201; and
//   * cancel **T2′** *restores* it as an immediately-takeable `pending_op`
//     rather than clearing the row's last-operation state, so no committed row
//     can ever rest `confirmed`/`pending`/`latest_action=NULL`/`pending_op=NULL`
//     — unreadable as a 201, unclaimable by notify, unreachable by repair
//     (CF-2 / REV14-01).

import {
  BookingChangedError,
  BookingFailedError,
  BookingOutcomeUnknownError,
  CalendarDeleteFailedError,
  OperationInProgressError,
  OperationSupersededError,
} from './errors';
import { bookingBody, buildEnvelope, type BookingEnvelope, type EnvelopeMeta } from './envelope';
import { newOperationId } from './ids';
import {
  beginOp,
  bumpVersion,
  finishAttempt,
  newAttempt,
  observeId,
  takeOverOp,
  unobserved,
  writeAttempt,
  classifyCalendarError,
  OUTCOME_DEFINITE,
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
  type PendingOp,
  type UnfinishedCreate,
} from './rows';
import { reconcileSuperseded } from './superseded';

export type CancelRequest = {
  bookingId: string;
  expectedRevision: number;
};

export type CancelDeps = {
  ctx: LifecycleContext;
  meta: EnvelopeMeta;
  notify: (row: BookingRow) => Promise<void>;
  /** Completes an inherited create/repair whose event is present. */
  completeInherited: (row: BookingRow, op: PendingOp) => Promise<void>;
  hooks?: {
    afterT1?: () => Promise<void>;
    afterDelete?: () => Promise<void>;
    beforeT2?: () => Promise<void>;
  };
};

export type CancelOutcome = {
  envelope: BookingEnvelope;
  row: BookingRow;
};

export async function cancelDurableBooking(
  deps: CancelDeps,
  request: CancelRequest,
  /** @internal — one re-entry only, after an inherited op completed. */
  pass = 0,
): Promise<CancelOutcome> {
  const { ctx } = deps;
  if (pass > 1) {
    throw new OperationInProgressError(1);
  }
  const existing = await ctx.store.getById(request.bookingId);
  if (existing === null) {
    throw new BookingChangedError();
  }

  if (existing.status === 'cancelled') {
    // Already terminal: the retry is idempotent — but cancel is a **designated
    // observing call** (C6.3a), and a retained insert can land after the cancel
    // released the interval. Returning 200 before the bounded reap would let
    // repeated cancel retries leave that late event on the host's calendar
    // forever (REV-04). The envelope is built from the reloaded row.
    if (hasEligibleReap(existing)) {
      await reapRetiredIds(ctx, existing.id);
    }
    const reaped = (await ctx.store.getById(existing.id)) ?? existing;
    return {
      envelope: await buildEnvelope(ctx.store, reaped, deps.meta, 'lifecycle'),
      row: reaped,
    };
  }

  const opId = newOperationId();

  const t1 = await ctx.store.withHostLock(existing.hostId, async (tx) => {
    const row = await tx.selectForUpdate(request.bookingId);
    if (row === null) {
      return { kind: 'gone' as const };
    }
    if (row.status !== 'confirmed' || row.revision !== request.expectedRevision) {
      return { kind: 'changed' as const, row };
    }

    let inherited: PendingOp | null = null;
    let inheritedStartedAt: string | null = null;
    let carry: UnfinishedCreate | null = row.unfinishedCreate;

    if (row.pendingOp !== null) {
      const op = row.pendingOp;
      if (op.kind === 'cancel') {
        if (!isStaleOp(op, ctx.clock.now())) {
          return { kind: 'busy' as const, row, op };
        }
        const taken = await takeOverOp(tx, row, op, ctx.clock);
        if (taken === null) {
          return { kind: 'raced' as const, row };
        }
        return { kind: 'resumed' as const, row, op: taken };
      }
      if (!isStaleOp(op, ctx.clock.now())) {
        // Refuse rather than race (C6.7).
        return { kind: 'busy' as const, row, op };
      }
      // `takeOverOp` stamps `startedAt = now`. The unfinished-create carry must
      // keep the ORIGINAL create's timestamp, which is what makes the restored
      // op immediately takeable after a cancel T2′ (C6.7 / REV14-01) instead of
      // parking the row for another full stale window.
      inheritedStartedAt = op.startedAt;
      const taken = await takeOverOp(tx, row, op, ctx.clock);
      if (taken === null) {
        return { kind: 'raced' as const, row };
      }
      inherited = taken;
    }

    const op = beginOp('cancel', ctx.clock, {
      opId,
      ...(row.googleEventId === null ? {} : { oldEventId: row.googleEventId }),
      ...(row.googleEventEtag === null ? {} : { etag: row.googleEventEtag }),
    });
    // Inherit the taken-over op's intended ids and ledger so nothing is lost.
    if (inherited !== null) {
      op.attempts = [...inherited.attempts];
      if (inherited.eventId !== undefined) {
        op.eventId = inherited.eventId;
      }
      if (inherited.fallbackEventId !== undefined) {
        op.fallbackEventId = inherited.fallbackEventId;
      }
      // An inherited op is reconciled from observed Google state *outside* the
      // lock before the cancel's own op can be written, so it is persisted by
      // the second, revision-conditioned transaction below.
      return {
        kind: 'started' as const,
        row,
        op,
        inherited,
        inheritedStartedAt,
        carry,
        persisted: false as const,
      };
    }

    // The ordinary cancel: persist the op in the SAME locked transaction that
    // validated `revision` and `pending_op`. Writing it later would leave a
    // window in which a reschedule could start or complete between validation
    // and persistence, and the cancel would then overwrite its ownership
    // (C6.7 / C6: every state-changing update is conditional on the revision
    // the caller validated).
    const persisted = await tx.update({
      id: row.id,
      expectedRevision: row.revision,
      requireConfirmed: true,
      patch: { pendingOp: op },
    });
    if (!persisted) {
      return { kind: 'raced' as const, row };
    }
    return {
      kind: 'started' as const,
      row,
      op,
      inherited: null,
      inheritedStartedAt,
      carry,
      persisted: true as const,
    };
  });

  if (t1.kind === 'gone') {
    throw new BookingChangedError();
  }
  if (t1.kind === 'changed') {
    throw new BookingChangedError(bookingBody(t1.row, deps.meta));
  }
  if (t1.kind === 'raced') {
    throw new OperationInProgressError(1);
  }
  if (t1.kind === 'busy') {
    throw new OperationInProgressError(retryAfterSeconds(t1.op, ctx.clock.now()));
  }
  if (t1.kind === 'resumed') {
    // C6.3c — a takeover's FIRST Google mutation invalidates the predecessor's
    // version, and that holds for a **same-kind** takeover too (REVIEW-01).
    // Without it the predecessor still holds a usable `If-Match`: it can be
    // paused before its own delete, watch this worker take the op over and hit
    // a definite delete refusal (T2′ clears `pending_op` and leaves the booking
    // `confirmed`/`created`), and then land its delete anyway — a confirmed row
    // whose calendar event is gone. The bump makes that delete 412 instead.
    for (const eventId of intendedIds(t1.op, t1.row)) {
      const bumped = await bumpVersion(ctx, t1.row, t1.op, eventId);
      if (bumped.state === 'ambiguous') {
        // Neither bumped nor known absent: the takeover stops under its new
        // `gen` and the retry re-observes (C6.3c).
        throw new BookingOutcomeUnknownError();
      }
    }
    return runCancelCalendarStep(deps, request, t1.row, t1.op);
  }

  // A taken-over create/repair/reschedule is reconciled BEFORE the cancel.
  let op = t1.op;
  let carry = t1.carry;
  let releaseReservation = false;
  if (t1.inherited !== null) {
    const outcome = await reconcileInherited(
      deps,
      t1.row,
      t1.inherited,
      op,
      t1.inheritedStartedAt ?? t1.inherited.startedAt,
    );
    if (outcome.kind === 'completed') {
      // The inherited op finished on its own terms; cancel the RESULTING event
      // under whatever revision that completion left behind (C6.7).
      return cancelDurableBooking(
        deps,
        {
          bookingId: request.bookingId,
          expectedRevision: outcome.revisionAdvanced
            ? request.expectedRevision + 1
            : request.expectedRevision,
        },
        pass + 1,
      );
    }
    carry = outcome.carry ?? carry;
    op = outcome.op;
    releaseReservation = outcome.releaseReservation;
  }

  // The ordinary cancel already persisted its op inside the validating lock.
  if (t1.persisted) {
    await deps.hooks?.afterT1?.();
    const withOwnOp = (await ctx.store.getById(t1.row.id)) ?? t1.row;
    return runCancelCalendarStep(deps, request, withOwnOp, op);
  }

  // Replacing a taken-over op: conditional on the revision this call validated
  // AND on the inherited op's `opId`/`gen`, so a reschedule that started or
  // completed in the meantime is never silently overwritten (C6.3, C6.7).
  const inheritedOp = t1.inherited;
  const started = await ctx.store.withHostLock(t1.row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(t1.row.id);
    if (fresh === null) {
      return false;
    }
    return tx.update({
      id: fresh.id,
      expectedRevision: t1.row.revision,
      requireConfirmed: true,
      ...(inheritedOp === null
        ? {}
        : { opId: inheritedOp.opId, gen: inheritedOp.gen }),
      patch: {
        pendingOp: op,
        ...(carry === null ? {} : { unfinishedCreate: carry }),
        // The abandoned reschedule's destination dies with its op (C6.1).
        ...(releaseReservation ? { reservedStart: null, reservedEnd: null } : {}),
      },
    });
  });
  if (!started) {
    throw new OperationInProgressError(1);
  }

  await deps.hooks?.afterT1?.();
  const withOp = (await ctx.store.getById(t1.row.id)) ?? t1.row;
  return runCancelCalendarStep(deps, request, withOp, op);
}

type InheritedOutcome =
  | { kind: 'completed'; revisionAdvanced: boolean }
  | {
      kind: 'proceed';
      op: PendingOp;
      carry: UnfinishedCreate | null;
      /**
       * C6.1/C6.6 — set when this takeover **abandoned** a reschedule that
       * achieved nothing. Its destination reservation must die with it: the
       * reschedule's own T2′ is never going to run, so the transaction that
       * replaces its `pending_op` is the one that has to release it, or the
       * destination stays occupied with no operation able to reconcile it
       * (LIVE-REVIEW-07).
       */
      releaseReservation: boolean;
    };

async function reconcileInherited(
  deps: CancelDeps,
  row: BookingRow,
  inherited: PendingOp,
  cancelOp: PendingOp,
  /** The taken-over op's timestamp BEFORE `takeOverOp` renewed it. */
  inheritedStartedAt: string,
): Promise<InheritedOutcome> {
  const { ctx } = deps;

  // Bump the version of every event that exists (C6.3c) before anything else.
  for (const eventId of intendedIds(inherited, row)) {
    const bumped = await bumpVersion(ctx, row, inherited, eventId);
    if (bumped.state === 'ambiguous') {
      throw new BookingOutcomeUnknownError();
    }
  }

  if (inherited.kind === 'create' || inherited.kind === 'calendar_repair') {
    const eventId = inherited.eventId as string;
    const observed = await observeId(ctx, row.id, eventId);
    if (unobserved(observed)) {
      // Refused or ambiguous: the id is NOT absent, so the create/repair may
      // neither be completed nor replaced. `pending_op` stays owned (C6.0).
      throw new BookingOutcomeUnknownError();
    }
    if (observed.state === 'present') {
      // Completed via its own T2. A create/repair completion changes neither
      // `start` nor `revision`, so the cancel retries at the same revision.
      await deps.completeInherited(row, inherited);
      return { kind: 'completed', revisionAdvanced: false };
    }
    // Absent → NOT abandoned: the id is retained, and a **create** replaced
    // this way is carried durably so it survives the replacement (C6.4a).
    const carry: UnfinishedCreate | null =
      inherited.kind === 'create' && row.latestAction === null
        ? {
            opId: inherited.opId,
            gen: inherited.gen,
            eventId,
            // The original create's timestamp, not the takeover's (REV14-01).
            startedAt: inheritedStartedAt,
            attempts: inherited.attempts.map((attempt) => ({ ...attempt })),
          }
        : null;
    return { kind: 'proceed', op: cancelOp, carry, releaseReservation: false };
  }

  // A stale reschedule: complete it if it achieved its move, else abandon it.
  const oldId = inherited.oldEventId;
  const fallbackId = inherited.fallbackEventId;
  const observedOld =
    oldId === undefined ? { state: 'absent' as const } : await observeId(ctx, row.id, oldId);
  const observedFallback =
    fallbackId === undefined
      ? { state: 'absent' as const }
      : await observeId(ctx, row.id, fallbackId);
  if (unobserved(observedOld) || unobserved(observedFallback)) {
    throw new BookingOutcomeUnknownError();
  }
  const moved = observedOld.state === 'present' && observedOld.event.start === inherited.newStart;
  if (moved || observedFallback.state === 'present') {
    // Completed via its own T2: `revision` advanced, so the cancel retries
    // against the new revision (C6.7).
    await deps.completeInherited(row, inherited);
    return { kind: 'completed', revisionAdvanced: true };
  }
  // Nothing achieved: the reschedule is abandoned and its outstanding fallback
  // id is retained by the cancel's own T2. Its destination reservation is
  // released by the transaction that replaces its op (C6.6 T2′ semantics).
  return { kind: 'proceed', op: cancelOp, carry: null, releaseReservation: true };
}

async function runCancelCalendarStep(
  deps: CancelDeps,
  request: CancelRequest,
  row: BookingRow,
  op: PendingOp,
): Promise<CancelOutcome> {
  const { ctx } = deps;

  // First the bounded, fair reap of this row's RETIRED ids — cleanup, never a
  // T2 precondition (REV6-02) — then the outstanding-insert check over every
  // intended id of the op it took over.
  if (hasEligibleReap(row)) {
    await reapRetiredIds(ctx, row.id);
  }
  for (const eventId of inheritedIntendedIds(op, row)) {
    const observed = await observeId(ctx, row.id, eventId);
    if (unobserved(observed)) {
      throw new BookingOutcomeUnknownError();
    }
    if (observed.state === 'present') {
      try {
        await ctx.calendar.remove({
          calendarId: ctx.calendarId,
          eventId,
          ifMatch: observed.event.etag,
          sendUpdates: 'none',
        });
        if (observed.event.marloAttemptId !== undefined) {
          await ctx.store.retireAttempt(row.id, observed.event.marloAttemptId);
        }
      } catch (error) {
        // C6.7 permits cancel T2 only when every present inherited id received
        // a **definite delete outcome**. A tolerated absence (404/410) counts;
        // any other definite refusal does not, and swallowing it would cancel
        // the booking while that event is still on the host's calendar.
        if (isAbsenceStatus(error)) {
          continue;
        }
        if (classifyCalendarError(error) === OUTCOME_DEFINITE) {
          await cancelT2Prime(deps, row, op);
          throw new CalendarDeleteFailedError();
        }
        throw new BookingOutcomeUnknownError();
      }
    }
  }

  const liveId = op.oldEventId;
  if (liveId !== undefined) {
    // Attribute the live id's deletion too, when an entry names it (REV6-01).
    const observed = await observeId(ctx, row.id, liveId);
    if (unobserved(observed)) {
      // A refused read must never become "already gone": committing
      // `calendar_state='deleted'` and releasing occupancy here would strand a
      // live event on the host's calendar.
      throw new BookingOutcomeUnknownError();
    }
    if (observed.state === 'present') {
      const attempt = newAttempt('delete', liveId, op.gen, ctx.clock, observed.event.etag);
      if (!(await writeAttempt(ctx, row, op, attempt))) {
        return supersededCancel(deps, row, op);
      }
      try {
        await ctx.calendar.remove({
          calendarId: ctx.calendarId,
          eventId: liveId,
          ifMatch: observed.event.etag,
          sendUpdates: ctx.sendUpdates,
        });
        await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
        if (observed.event.marloAttemptId !== undefined) {
          await ctx.store.retireAttempt(row.id, observed.event.marloAttemptId);
        }
      } catch (error) {
        const klass = classifyCalendarError(error);
        if (klass === 'precondition_failed' || klass === OUTCOME_DEFINITE) {
          await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
          await cancelT2Prime(deps, row, op);
          throw new CalendarDeleteFailedError();
        }
        // Ambiguous (incl. 429): `pending_op` retained, occupancy still held.
        throw new BookingOutcomeUnknownError();
      }
    }
  }

  await deps.hooks?.afterDelete?.();
  await deps.hooks?.beforeT2?.();

  const completed = await cancelT2(deps, row, op);
  if (completed.superseded) {
    return supersededCancel(deps, row, op);
  }
  await deps.notify(completed.row);
  const fresh = (await ctx.store.getById(row.id)) ?? completed.row;
  return {
    envelope: await buildEnvelope(ctx.store, fresh, deps.meta, 'lifecycle'),
    row: fresh,
  };
}

async function cancelT2(
  deps: CancelDeps,
  row: BookingRow,
  op: PendingOp,
): Promise<{ superseded: boolean; row: BookingRow }> {
  const { ctx } = deps;
  const settled = await settleCompletion(
    ctx,
    row,
    () => cancelT2Tx(deps, row, op),
    (fresh) => fresh !== null && fresh.status === 'cancelled',
  );
  if (settled.kind === 'reconciled') {
    return { superseded: false, row: settled.row };
  }
  if (settled.kind === 'failed') {
    // Nothing to compensate — the delete already happened and deleting an
    // already-deleted event is a tolerated 404. `pending_op` stays, so the next
    // cancel call resumes at T2 and answers 200 `cancelled` (C6.7).
    throw new BookingFailedError();
  }
  return settled.value;
}

async function cancelT2Tx(
  deps: CancelDeps,
  row: BookingRow,
  op: PendingOp,
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
        status: 'cancelled',
        calendarState: 'deleted',
        bumpRevision: true,
        // Finalizes any create this cancel inherited unfinished (REV14-01),
        // which is why the cancelled-booking replay still answers 201.
        latestAction: 'cancel',
        pendingOp: null,
        unfinishedCreate: null,
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

/**
 * Cancel T2′ (REV14-01). With nothing inherited unfinished it clears
 * `pending_op` as before. With `unfinished_create` set it may **not** leave the
 * row ownerless with an unfinished create (CF-2): in the same transaction it
 * restores that create as a resumable op — the original `startedAt`, so it is
 * immediately takeable, and a bumped `gen`, so the original worker can only
 * reconcile, never complete.
 */
async function cancelT2Prime(
  deps: CancelDeps,
  row: BookingRow,
  op: PendingOp,
): Promise<void> {
  await deps.ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null) {
      return;
    }
    const retained = retainedFrom(fresh.unresolvedInserts, fresh.pendingOp.attempts);
    const carry = fresh.unfinishedCreate;
    if (carry === null) {
      await tx.update({
        id: row.id,
        expectedRevision: fresh.revision,
        opId: op.opId,
        gen: op.gen,
        patch: {
          pendingOp: null,
          // The clearing transaction leaves no reservation behind: any
          // destination this cancel inherited from an abandoned reschedule has
          // no operation left to reconcile it (C6.1 — LIVE-REVIEW-07). A row
          // that never held one is unaffected.
          reservedStart: null,
          reservedEnd: null,
          unresolvedInserts: retained,
        },
      });
      return;
    }
    const restored: PendingOp = {
      kind: 'create',
      opId: carry.opId,
      // Higher than any gen this row has carried for that opId.
      gen: Math.max(carry.gen, fresh.pendingOp.gen) + 1,
      // The ORIGINAL create's startedAt: already past the stale window, so
      // nobody waits on a worker that no longer exists.
      startedAt: carry.startedAt,
      eventId: carry.eventId,
      attempts: [
        ...carry.attempts.map((attempt) => ({ ...attempt })),
        ...fresh.pendingOp.attempts
          .filter((attempt) => attempt.kind === 'insert' && attempt.outcome === 'unresolved')
          .map((attempt) => ({ ...attempt })),
      ],
    };
    await tx.update({
      id: row.id,
      expectedRevision: fresh.revision,
      opId: op.opId,
      gen: op.gen,
      patch: {
        pendingOp: restored,
        unresolvedInserts: retained,
        // `unfinished_create` stays set; `latest_action` stays NULL (CF-3).
      },
    });
  });
}

async function supersededCancel(
  deps: CancelDeps,
  row: BookingRow,
  op: PendingOp,
): Promise<CancelOutcome> {
  const decision = await reconcileSuperseded(
    deps.ctx,
    { kind: 'cancel', op, bookingId: row.id },
    row.hostId,
  );
  if (decision.response === 'success' && decision.row !== null) {
    return {
      envelope: await buildEnvelope(deps.ctx.store, decision.row, deps.meta, 'lifecycle'),
      row: decision.row,
    };
  }
  if (decision.response === 'operation_in_progress') {
    throw new OperationInProgressError(decision.retryAfterSeconds ?? 1);
  }
  throw new OperationSupersededError(
    decision.row === null ? undefined : bookingBody(decision.row, deps.meta),
  );
}

function intendedIds(op: PendingOp, row: BookingRow): string[] {
  const ids = [op.eventId, op.fallbackEventId, op.oldEventId ?? row.googleEventId ?? undefined];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
}

/** Intended ids the cancel inherited — excluding the live id it deletes itself. */
function inheritedIntendedIds(op: PendingOp, row: BookingRow): string[] {
  const live = op.oldEventId ?? row.googleEventId;
  return [op.eventId, op.fallbackEventId]
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .filter((id) => id !== live);
}
