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
  writeAttempt,
  classifyCalendarError,
  OUTCOME_DEFINITE,
  type LifecycleContext,
} from './ops';
import { hasEligibleReap, reapRetiredIds } from './reap';
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
    // Already terminal: the retry is idempotent.
    return {
      envelope: await buildEnvelope(ctx.store, existing, deps.meta, 'lifecycle'),
      row: existing,
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
    }

    return {
      kind: 'started' as const,
      row,
      op,
      inherited,
      carry,
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
    return runCancelCalendarStep(deps, request, t1.row, t1.op);
  }

  // A taken-over create/repair/reschedule is reconciled BEFORE the cancel.
  let op = t1.op;
  let carry = t1.carry;
  if (t1.inherited !== null) {
    const outcome = await reconcileInherited(deps, t1.row, t1.inherited, op);
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
  }

  // Persist the cancel op (with the inherited ids) and the unfinished-create
  // carry together, in one T1 update.
  const started = await ctx.store.withHostLock(t1.row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(t1.row.id);
    if (fresh === null) {
      return false;
    }
    return tx.update({
      id: fresh.id,
      expectedRevision: fresh.revision,
      patch: {
        pendingOp: op,
        ...(carry === null ? {} : { unfinishedCreate: carry }),
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
  | { kind: 'proceed'; op: PendingOp; carry: UnfinishedCreate | null };

async function reconcileInherited(
  deps: CancelDeps,
  row: BookingRow,
  inherited: PendingOp,
  cancelOp: PendingOp,
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
    if (observed.state === 'ambiguous') {
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
            startedAt: inherited.startedAt,
            attempts: inherited.attempts.map((attempt) => ({ ...attempt })),
          }
        : null;
    return { kind: 'proceed', op: cancelOp, carry };
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
  if (observedOld.state === 'ambiguous' || observedFallback.state === 'ambiguous') {
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
  // id is retained by the cancel's own T2.
  return { kind: 'proceed', op: cancelOp, carry: null };
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
    if (observed.state === 'ambiguous') {
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
        if (classifyCalendarError(error) !== OUTCOME_DEFINITE) {
          throw new BookingOutcomeUnknownError();
        }
      }
    }
  }

  const liveId = op.oldEventId;
  if (liveId !== undefined) {
    // Attribute the live id's deletion too, when an entry names it (REV6-01).
    const observed = await observeId(ctx, row.id, liveId);
    if (observed.state === 'ambiguous') {
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
        patch: { pendingOp: null, unresolvedInserts: retained },
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
  const decision = await reconcileSuperseded(deps.ctx, {
    kind: 'cancel',
    op,
    bookingId: row.id,
  });
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
