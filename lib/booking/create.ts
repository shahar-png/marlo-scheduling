// C6.4 — the two-phase create, in the one order the PLAN fixes:
//
//   L0  locked idempotency + fence lookup, BEFORE any Google traffic (REV7-02)
//   R0  external-availability read, outside any transaction, missing keys only
//   T1  lock → mandatory second key + fence lookup → external-busy check →
//       reservation-aware managed conflict check → INSERT (or the durable
//       rejection fence) → COMMIT
//       ── the slot is now durably held ──
//   ins events.insert under the intended id, recorded as an attempt in T1
//   T2  owned conditional update clearing `pending_op`, retaining every
//       unresolved insert attempt (C6.3b clearing rule)
//   →   emails for `(1, 'confirm')`
//
// A create is **never abandoned**: its intended id is either completed or, when
// a cancel takes it over with the event absent, retained on the row and carried
// in `unfinished_create` until something finalizes it (C6.4a / C6.7).

import { UnknownCommitError } from '../db/index';
import { AvailabilityUnknownError } from '../google/errors';
import { logLifecycle } from './log';
import {
  AvailabilityUnknownResponse,
  BookingFailedError,
  BookingOutcomeUnknownError,
  IdempotencyKeyReusedError,
  OperationInProgressError,
  OperationSupersededError,
  SessionFullError,
  SlotUnavailableError,
} from './errors';
import {
  bookingBody,
  buildEnvelope,
  type BookingEnvelope,
  type EnvelopeMeta,
} from './envelope';
import { createFingerprint } from './fingerprint';
import { newBookingId, newBookingToken, newCalendarEventId, newOperationId } from './ids';
import { busyOverlaps, externalBusy } from './occupancy';
import {
  beginOp,
  finishAttempt,
  newAttempt,
  observeId,
  takeOverOp,
  writeAttempt,
  OUTCOME_DEFINITE,
  classifyCalendarError,
  type LifecycleContext,
} from './ops';
import {
  isStaleOp,
  retainedFrom,
  retryAfterSeconds,
  type BookingRow,
  type Interval,
  type PendingOp,
  type RejectionReason,
} from './rows';
import { cleanupOwnEvent, reconcileSuperseded, retireWithoutDelete } from './superseded';
import type { CreateOpIdentity } from './create-identity';
import { OutcomeUnresolvedError } from './store';

export type CreateBookingRequest = {
  ownerId: string;
  ownerSlug: string;
  ownerEmail: string;
  hostFirstName: string;
  hostId: string;
  eventTypeId: string;
  eventSlug: string;
  eventName: string;
  durationMinutes: number;
  start: string;
  invitee: { name: string; email: string };
  notes: string | null;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  timeZone?: string;
};

export type CreateOutcome = {
  envelope: BookingEnvelope;
  row: BookingRow;
  /** True when the row already existed (a C9 replay). */
  replayed: boolean;
};

export type CreateHooks = {
  /** Test seam: pauses between R0 and T1, or between T1 and the insert. */
  afterR0?: () => Promise<void>;
  afterT1?: () => Promise<void>;
  afterInsert?: () => Promise<void>;
  /** Aborts before T2, simulating process death. */
  beforeT2?: () => Promise<void>;
};

export type CreateDeps = {
  ctx: LifecycleContext;
  meta: EnvelopeMeta;
  /** Runs the `(1, 'confirm')` emails after T2/T2′ commits. */
  notify: (row: BookingRow) => Promise<void>;
  hooks?: CreateHooks;
};

export async function createDurableBooking(
  deps: CreateDeps,
  request: CreateBookingRequest,
): Promise<CreateOutcome> {
  const { ctx } = deps;
  const fingerprint = createFingerprint({
    eventTypeId: request.eventTypeId,
    start: request.start,
    inviteeEmail: request.invitee.email,
  });
  const window = intervalOf(request);

  // ---- L0 ---------------------------------------------------------------
  const l0 = await ctx.store.withHostLock(request.hostId, async (tx) => {
    const fence = await tx.lookupRejection(request.ownerId, request.idempotencyKey, fingerprint);
    if (fence !== null) {
      return { kind: 'fenced' as const, reason: fence };
    }
    const row = await tx.lookupKey(request.ownerId, request.idempotencyKey);
    return row === null ? { kind: 'missing' as const } : { kind: 'existing' as const, row };
  });

  if (l0.kind === 'fenced') {
    // The rejection this key+payload already received is repeated, never
    // re-evaluated — zero Google calls, nothing written (REV8-01).
    logLifecycle('create_fenced', { key: request.idempotencyKey, reason: l0.reason });
    throw rejectionError(l0.reason);
  }
  if (l0.kind === 'existing') {
    return replayOrResume(deps, request, l0.row, fingerprint);
  }

  // ---- R0 ---------------------------------------------------------------
  let external: Interval[];
  try {
    external = await externalBusy(ctx, {
      window,
      ...(request.timeZone === undefined ? {} : { timeZone: request.timeZone }),
    });
  } catch (error) {
    if (error instanceof AvailabilityUnknownError) {
      // Nothing written, no fence: non-terminal, the client retains its key.
      throw new AvailabilityUnknownResponse();
    }
    throw error;
  }
  await deps.hooks?.afterR0?.();

  // ---- T1 ---------------------------------------------------------------
  const intendedId = newCalendarEventId();
  const opId = newOperationId();
  const bookingId = newBookingId();
  const token = newBookingToken();

  let t1: T1Result;
  try {
    t1 = await ctx.store.withHostLock(request.hostId, async (tx) => {
      // Mandatory second lookup: a concurrent same-key request can commit
      // between L0 and this lock (AC-19(i)(6)).
      const fence = await tx.lookupRejection(
        request.ownerId,
        request.idempotencyKey,
        fingerprint,
      );
      if (fence !== null) {
        return { kind: 'fenced', reason: fence };
      }
      const existing = await tx.lookupKey(request.ownerId, request.idempotencyKey);
      if (existing !== null) {
        // X is discarded: a replay never consults the external snapshot.
        return { kind: 'existing', row: existing };
      }
      if (busyOverlaps(window, external)) {
        await fenceRejection(tx, request, fingerprint, 'slot_unavailable');
        return { kind: 'rejected', reason: 'slot_unavailable' };
      }
      // The locked re-check: X is a snapshot, managed occupancy is authoritative.
      const managed = await tx.occupancy({ hostId: request.hostId, window });
      if (busyOverlaps(window, managed)) {
        await fenceRejection(tx, request, fingerprint, 'slot_unavailable');
        return { kind: 'rejected', reason: 'slot_unavailable' };
      }

      const op = beginOp('create', ctx.clock, { opId, eventId: intendedId });
      // The first insert's attempt entry is part of T1 itself (C6.3b).
      const attempt = newAttempt('insert', intendedId, 1, ctx.clock);
      op.attempts = [attempt];
      const row = await tx.insertBooking({
        id: bookingId,
        token,
        idempotencyKey: request.idempotencyKey,
        createFingerprint: fingerprint,
        ownerId: request.ownerId,
        eventTypeId: request.eventTypeId,
        hostId: request.hostId,
        start: window.start,
        end: window.end,
        googleEventId: intendedId,
        pendingOp: op,
        inviteeName: request.invitee.name,
        inviteeEmail: request.invitee.email,
        notes: request.notes,
        metadata: request.metadata,
        createdAt: new Date(ctx.clock.now()).toISOString(),
      });
      return { kind: 'inserted', row, op, attemptId: attempt.attemptId };
    });
  } catch (error) {
    if (error instanceof UnknownCommitError) {
      // C6.5: reacquire the lock on a fresh connection — which establishes the
      // original transaction has finished — and only then read.
      t1 = await reconcileT1(deps, request, fingerprint);
    } else {
      throw error;
    }
  }

  if (t1.kind === 'fenced') {
    logLifecycle('create_fenced', { key: request.idempotencyKey, reason: t1.reason });
    throw rejectionError(t1.reason);
  }
  if (t1.kind === 'rejected') {
    throw rejectionError(t1.reason);
  }
  if (t1.kind === 'existing') {
    return replayOrResume(deps, request, t1.row, fingerprint);
  }
  if (t1.kind === 'failed') {
    throw new BookingFailedError();
  }

  await deps.hooks?.afterT1?.();

  const identity: CreateOpIdentity = {
    opId: t1.op.opId,
    ownerId: request.ownerId,
    idempotencyKey: request.idempotencyKey,
    createFingerprint: fingerprint,
    bookingId: t1.row.id,
  };

  return runCreateCalendarStep(deps, request, t1.row, t1.op, t1.attemptId, identity);
}

type T1Result =
  | { kind: 'inserted'; row: BookingRow; op: PendingOp; attemptId: string }
  | { kind: 'existing'; row: BookingRow }
  | { kind: 'rejected'; reason: RejectionReason }
  | { kind: 'fenced'; reason: RejectionReason }
  | { kind: 'failed' };

async function reconcileT1(
  deps: CreateDeps,
  request: CreateBookingRequest,
  fingerprint: string,
): Promise<T1Result> {
  try {
    return await deps.ctx.store.withFinishedTransaction(request.hostId, async (tx) => {
      const row = await tx.lookupKey(request.ownerId, request.idempotencyKey);
      if (row !== null) {
        return { kind: 'existing', row } as T1Result;
      }
      const fence = await tx.lookupRejection(
        request.ownerId,
        request.idempotencyKey,
        fingerprint,
      );
      if (fence !== null) {
        return { kind: 'fenced', reason: fence } as T1Result;
      }
      return { kind: 'failed' } as T1Result;
    });
  } catch (error) {
    if (error instanceof OutcomeUnresolvedError) {
      logLifecycle('outcome_unresolved', { key: request.idempotencyKey });
      throw new BookingOutcomeUnknownError();
    }
    throw error;
  }
}

async function fenceRejection(
  tx: Parameters<Parameters<LifecycleContext['store']['withHostLock']>[1]>[0],
  request: CreateBookingRequest,
  fingerprint: string,
  reason: RejectionReason,
): Promise<void> {
  // The fence is written in the SAME locked transaction that rejects, which is
  // what makes the rejection terminal: no request carrying this key and payload
  // can ever insert a row later (REV8-01).
  await tx.insertRejection({
    ownerId: request.ownerId,
    idempotencyKey: request.idempotencyKey,
    createFingerprint: fingerprint,
    reason,
  });
}

/**
 * The calendar step plus T2/T2′, shared by the first attempt and by every
 * resume (C6.4 Resume, C6.8 notify N-1).
 */
export async function runCreateCalendarStep(
  deps: CreateDeps,
  request: CreateBookingRequest,
  row: BookingRow,
  op: PendingOp,
  attemptId: string,
  identity: CreateOpIdentity,
): Promise<CreateOutcome> {
  const { ctx } = deps;
  const eventId = op.eventId as string;

  let etag: string | null = null;
  let insertOutcome: 'applied' | 'definite' | 'ambiguous' = 'ambiguous';
  let insertEtag: string | null = null;

  try {
    const event = await ctx.calendar.insert({
      calendarId: ctx.calendarId,
      id: eventId,
      start: row.start,
      end: row.end,
      summary: request.eventName,
      bookingId: row.id,
      attemptId,
      sendUpdates: ctx.sendUpdates,
      ...(ctx.sendUpdates === 'all'
        ? {
            attendees: [
              { email: request.invitee.email, displayName: request.invitee.name },
            ],
          }
        : {}),
    });
    insertOutcome = 'applied';
    insertEtag = event.etag;
    etag = event.etag;
    await finishAttempt(ctx, row, op, attemptId, 'applied');
  } catch (error) {
    const klass = classifyCalendarError(error);
    if (klass === 'already_exists') {
      // This request created nothing; `events.get` decides the OP (C6.2).
      await finishAttempt(ctx, row, op, attemptId, 'rejected');
      const observed = await observeId(ctx, row.id, eventId);
      if (observed.state === 'present') {
        insertOutcome = 'applied';
        etag = observed.event.etag;
      } else if (observed.state === 'absent') {
        // One further insert attempt; the earlier one stays unresolved.
        const retry = await retryInsert(deps, request, row, op, eventId);
        if (retry.outcome === 'ambiguous') {
          throw new BookingOutcomeUnknownError();
        }
        insertOutcome = retry.outcome;
        etag = retry.etag;
        insertEtag = retry.etag;
      } else {
        throw new BookingOutcomeUnknownError();
      }
    } else if (klass === OUTCOME_DEFINITE) {
      await finishAttempt(ctx, row, op, attemptId, 'rejected');
      insertOutcome = 'definite';
    } else {
      // Ambiguous (timeout, 5xx, 429, network): the attempt stays unresolved,
      // `pending_op` is retained, nothing is written, 503 (C6.0).
      logLifecycle('attempt_unresolved', {
        bookingId: row.id,
        opId: op.opId,
        gen: op.gen,
        attemptId,
        eventId,
      });
      throw new BookingOutcomeUnknownError();
    }
  }

  await deps.hooks?.afterInsert?.();
  await deps.hooks?.beforeT2?.();

  const completed = await completeCreate(
    deps,
    row,
    op,
    insertOutcome === 'applied' ? 'created' : 'failed',
    etag,
  );

  if (completed.superseded) {
    return supersededCreate(deps, request, row, op, identity, {
      insertApplied: insertOutcome === 'applied',
      insertEtag,
      eventId,
      attemptId,
    });
  }

  await deps.notify(completed.row);
  const fresh = (await ctx.store.getById(row.id)) ?? completed.row;
  return {
    envelope: await buildEnvelope(
      ctx.store,
      fresh,
      deps.meta,
      'create',
      insertOutcome === 'definite' ? { calendar: 'calendar_insert_failed' } : undefined,
    ),
    row: fresh,
    replayed: false,
  };
}

async function retryInsert(
  deps: CreateDeps,
  request: CreateBookingRequest,
  row: BookingRow,
  op: PendingOp,
  eventId: string,
): Promise<{ outcome: 'applied' | 'definite' | 'ambiguous'; etag: string | null }> {
  const { ctx } = deps;
  const attempt = newAttempt('insert', eventId, op.gen, ctx.clock);
  if (!(await writeAttempt(ctx, row, op, attempt))) {
    // Superseded before the second insert: never reaches Google.
    return { outcome: 'ambiguous', etag: null };
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
    });
    await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
    return { outcome: 'applied', etag: event.etag };
  } catch (error) {
    const klass = classifyCalendarError(error);
    if (klass === OUTCOME_DEFINITE) {
      // Resolves only THIS attempt; an earlier ambiguous one stays unresolved.
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      return { outcome: 'definite', etag: null };
    }
    if (klass === 'already_exists') {
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      const observed = await observeId(ctx, row.id, eventId);
      if (observed.state === 'present') {
        return { outcome: 'applied', etag: observed.event.etag };
      }
      return { outcome: 'ambiguous', etag: null };
    }
    logLifecycle('attempt_unresolved', {
      bookingId: row.id,
      opId: op.opId,
      gen: op.gen,
      attemptId: attempt.attemptId,
      eventId,
    });
    return { outcome: 'ambiguous', etag: null };
  }
}

/**
 * T2 (`created`) and T2′ (`failed`). Both write a **non-null** `latest_action`
 * — the creation is finalized either way; only the calendar outcome differs
 * (REV3-03) — clear `unfinished_create` (CF-3), and retain every unresolved
 * insert attempt, **including one naming the resulting `google_event_id`**
 * (C6.3b clearing rule / REV5-01).
 */
async function completeCreate(
  deps: CreateDeps,
  row: BookingRow,
  op: PendingOp,
  calendarState: 'created' | 'failed',
  etag: string | null,
): Promise<{ superseded: boolean; row: BookingRow }> {
  const { ctx } = deps;
  const result = await ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null) {
      return { superseded: true, row: fresh ?? row };
    }
    const retained = retainedFrom(fresh.unresolvedInserts, fresh.pendingOp.attempts);
    const updated = await tx.update({
      id: row.id,
      expectedRevision: fresh.revision,
      opId: op.opId,
      gen: op.gen,
      patch: {
        latestAction: 'confirm',
        calendarState,
        ...(etag === null ? {} : { googleEventEtag: etag }),
        pendingOp: null,
        unfinishedCreate: null,
        unresolvedInserts: retained,
      },
    });
    if (!updated) {
      return { superseded: true, row: fresh };
    }
    for (const entry of retained) {
      logLifecycle('attempt_unresolved', {
        bookingId: row.id,
        opId: op.opId,
        gen: op.gen,
        attemptId: entry.attemptId,
        eventId: entry.eventId,
      });
    }
    return { superseded: false, row: fresh };
  });
  if (result.superseded) {
    return result;
  }
  const after = (await ctx.store.getById(row.id)) ?? result.row;
  return { superseded: false, row: after };
}

async function supersededCreate(
  deps: CreateDeps,
  request: CreateBookingRequest,
  row: BookingRow,
  op: PendingOp,
  identity: CreateOpIdentity,
  insert: {
    insertApplied: boolean;
    insertEtag: string | null;
    eventId: string;
    attemptId: string;
  },
): Promise<CreateOutcome> {
  const decision = await reconcileSuperseded(deps.ctx, {
    kind: 'create',
    op,
    identity,
    bookingId: row.id,
  });

  // (2) Cleanup eligibility is decided separately from (1), and only a
  // definite 2xx insert response may act on it.
  if (decision.eligible && insert.insertApplied && insert.insertEtag !== null) {
    await cleanupOwnEvent(
      deps.ctx,
      row.id,
      insert.eventId,
      insert.attemptId,
      insert.insertEtag,
    );
  } else if (decision.eligible && !insert.insertApplied) {
    await retireWithoutDelete(deps.ctx, row.id, insert.attemptId);
  }

  if (decision.response === 'operation_in_progress') {
    throw new OperationInProgressError(decision.retryAfterSeconds ?? 1);
  }
  if (decision.response === 'operation_superseded' || decision.row === null) {
    // The defensive identity-mismatch branch. Non-terminal for the client's key
    // (C9): the replay resolves through the C9 lookup.
    throw new OperationSupersededError(
      decision.row === null ? undefined : bookingBody(decision.row, deps.meta),
    );
  }

  // `success` → the calling route's success status, which for a create is 201
  // with the row's CURRENT state (REV8-02, REV9-01).
  return {
    envelope: await buildEnvelope(deps.ctx.store, decision.row, deps.meta, 'create'),
    row: decision.row,
    replayed: true,
  };
}

/**
 * C6.4 L0 / C9 replay. Answers from the row alone — with **zero Google calls**,
 * and explicitly **without** the C6.3a reap even when the row is cancelled and
 * retains reap-eligible ids (REV11-02) — or resumes a stale create.
 */
export async function replayOrResume(
  deps: CreateDeps,
  request: CreateBookingRequest,
  row: BookingRow,
  fingerprint: string,
): Promise<CreateOutcome> {
  const { ctx } = deps;
  if (row.createFingerprint !== fingerprint) {
    throw new IdempotencyKeyReusedError();
  }

  const identity: CreateOpIdentity = {
    opId: row.pendingOp?.opId ?? row.unfinishedCreate?.opId ?? '',
    ownerId: row.ownerId,
    idempotencyKey: row.idempotencyKey,
    createFingerprint: row.createFingerprint,
    bookingId: row.id,
  };

  // (1) An open create op → resume it.
  if (row.pendingOp !== null && row.pendingOp.kind === 'create') {
    if (!isStaleOp(row.pendingOp, ctx.clock.now())) {
      // Owned elsewhere: non-terminal, zero Google calls, nothing written.
      throw new OperationInProgressError(retryAfterSeconds(row.pendingOp, ctx.clock.now()));
    }
    const taken = await ctx.store.withHostLock(row.hostId, async (tx) => {
      const fresh = await tx.selectForUpdate(row.id);
      if (fresh === null || fresh.pendingOp === null || fresh.pendingOp.kind !== 'create') {
        return null;
      }
      return takeOverOp(tx, fresh, fresh.pendingOp, ctx.clock);
    });
    if (taken === null) {
      throw new OperationInProgressError(1);
    }
    return resumeCreate(deps, request, row, taken, identity);
  }

  // (2) Finalized → 201 from the row, whatever `pending_op` now holds.
  if (row.latestAction !== null) {
    return {
      envelope: await buildEnvelope(ctx.store, row, deps.meta, 'create'),
      row,
      replayed: true,
    };
  }

  // (3) Unfinished under a non-create op, or a restored one → non-terminal.
  if (row.pendingOp !== null || row.unfinishedCreate !== null) {
    throw new OperationInProgressError(
      row.pendingOp === null ? 1 : retryAfterSeconds(row.pendingOp, ctx.clock.now()),
    );
  }

  // CF-2 excludes this combination; never answered 201.
  logLifecycle('unfinished_create_orphan', { bookingId: row.id });
  throw new OperationInProgressError(1);
}

/**
 * Completes an inherited or resumed create from observed Google state:
 * present → T2; definitely absent → one `events.insert` under the **same**
 * intended id → T2; definite failure → T2′; ambiguous → 503 with `pending_op`
 * retained. Shared by the C9 replay and by notify's N-1 (C6.8 / REV15-01).
 */
export async function resumeCreate(
  deps: CreateDeps,
  request: CreateBookingRequest,
  row: BookingRow,
  op: PendingOp,
  identity: CreateOpIdentity,
): Promise<CreateOutcome> {
  const { ctx } = deps;
  const eventId = op.eventId as string;
  const observed = await observeId(ctx, row.id, eventId);

  if (observed.state === 'ambiguous') {
    throw new BookingOutcomeUnknownError();
  }
  if (observed.state === 'present') {
    const completed = await completeCreate(deps, row, op, 'created', observed.event.etag);
    if (completed.superseded) {
      return supersededCreate(deps, request, row, op, identity, {
        insertApplied: false,
        insertEtag: null,
        eventId,
        attemptId: '',
      });
    }
    await deps.notify(completed.row);
    const fresh = (await ctx.store.getById(row.id)) ?? completed.row;
    return {
      envelope: await buildEnvelope(ctx.store, fresh, deps.meta, 'create'),
      row: fresh,
      replayed: true,
    };
  }

  // Absent → exactly one insert under the same id.
  const attempt = newAttempt('insert', eventId, op.gen, ctx.clock);
  if (!(await writeAttempt(ctx, row, op, attempt))) {
    throw new OperationInProgressError(1);
  }
  const resumedOp: PendingOp = { ...op, attempts: [...op.attempts, attempt] };
  return runCreateCalendarStep(deps, request, row, resumedOp, attempt.attemptId, identity);
}

export function intervalOf(request: {
  start: string;
  durationMinutes: number;
}): Interval {
  const startMs = Date.parse(request.start);
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(startMs + request.durationMinutes * 60_000).toISOString(),
  };
}

function rejectionError(reason: RejectionReason): Error {
  return reason === 'session_full' ? new SessionFullError() : new SlotUnavailableError();
}
