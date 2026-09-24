// Owned operation state (C6.2, C6.3, C6.3b, C6.3c).
//
// The rules encoded here, once, for every lifecycle step:
//   * an operation's identity, generation, and **intended event id** are
//     durable before any Google mutation (C6.2);
//   * every Google mutation is preceded by a durable **attempt** entry that is
//     conditioned on `opId`/`gen`, so a worker that has been superseded never
//     reaches Google (C6.3 / C6.3b);
//   * an attempt is finalised only by its own request's response — a later
//     attempt never resolves an earlier one (C6.3b);
//   * a takeover's **first** Google mutation is the version bump, so a
//     predecessor that paused after its attempt write cannot land (C6.3c).

import { type Clock } from '../clock';
import {
  AlreadyExistsError,
  AMBIGUOUS,
  APPLIED,
  CalendarError,
  DEFINITE,
  PreconditionFailedError,
  classifyCalendarError,
  isAbsenceStatus,
  type CalendarOutcomeClass,
} from '../google/errors';
import type { CalendarClient, CalendarEvent, SendUpdates } from '../google/calendar';
import { newAttemptId } from './ids';
import { logLifecycle } from './log';
import type { BookingStore, BookingTx } from './store';
import {
  cloneOp,
  isStaleOp,
  retryAfterSeconds,
  type Attempt,
  type AttemptKind,
  type BookingRow,
  type OpKind,
  type PendingOp,
} from './rows';

export type LifecycleContext = {
  store: BookingStore;
  calendar: CalendarClient;
  calendarId: string;
  clock: Clock;
  /** C4: `all` only under `calendar_invitation`; occupancy is unconditional. */
  sendUpdates: SendUpdates;
};

export function beginOp(
  kind: OpKind,
  clock: Clock,
  fields: Partial<Omit<PendingOp, 'kind' | 'gen' | 'startedAt' | 'attempts'>> & {
    opId: string;
  },
): PendingOp {
  return {
    kind,
    opId: fields.opId,
    gen: 1,
    startedAt: new Date(clock.now()).toISOString(),
    ...(fields.eventId === undefined ? {} : { eventId: fields.eventId }),
    ...(fields.newStart === undefined ? {} : { newStart: fields.newStart }),
    ...(fields.newEnd === undefined ? {} : { newEnd: fields.newEnd }),
    ...(fields.oldEventId === undefined ? {} : { oldEventId: fields.oldEventId }),
    ...(fields.fallbackEventId === undefined
      ? {}
      : { fallbackEventId: fields.fallbackEventId }),
    ...(fields.etag === undefined ? {} : { etag: fields.etag }),
    attempts: [],
  };
}

export function newAttempt(
  kind: AttemptKind,
  eventId: string,
  gen: number,
  clock: Clock,
  ifMatch?: string,
): Attempt {
  return {
    attemptId: newAttemptId(),
    kind,
    eventId,
    gen,
    issuedAt: new Date(clock.now()).toISOString(),
    ...(ifMatch === undefined ? {} : { ifMatch }),
    outcome: 'unresolved',
  };
}

export class SupersededError extends Error {
  constructor(readonly bookingId: string) {
    super('operation_superseded');
    this.name = 'SupersededError';
  }
}

/**
 * C6.3: writes the attempt under the host lock, conditioned on ownership, and
 * commits before the request goes out. A `false` return means this worker is
 * superseded and must reach neither Google nor a completing update.
 */
export async function writeAttempt(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
  attempt: Attempt,
): Promise<boolean> {
  return ctx.store.withHostLock(row.hostId, (tx) =>
    tx.appendAttempt(row.id, op.opId, op.gen, attempt),
  );
}

/** Finalises an attempt from its OWN response (C6.3b). */
export async function finishAttempt(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
  attemptId: string,
  outcome: 'applied' | 'rejected',
): Promise<void> {
  await ctx.store.withHostLock(row.hostId, (tx) =>
    tx.resolveAttempt(
      row.id,
      op.opId,
      op.gen,
      attemptId,
      outcome,
      new Date(ctx.clock.now()).toISOString(),
    ),
  );
}

/**
 * C6.0/C6.3b — settles an attempt from the **error** its own request returned.
 *
 * Only an outcome that proves the request did nothing may resolve the attempt:
 * a `definite` 4xx, a 409 `duplicate`, or a 412. A 429, a 5xx, a timeout, or a
 * lost connection prove nothing — the mutation may still execute — so the
 * attempt stays `unresolved` for as long as this app exists, which is what keeps
 * any event that later lands under its id attributable and reapable.
 */
export async function failAttempt(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
  attemptId: string,
  error: unknown,
): Promise<void> {
  const klass = classifyCalendarError(error);
  if (klass === AMBIGUOUS || klass === APPLIED) {
    return;
  }
  await finishAttempt(ctx, row, op, attemptId, 'rejected');
}

export type Observation =
  | { state: 'present'; event: CalendarEvent }
  | { state: 'absent' }
  /**
   * The **read itself** was definitely refused (401, 403, 400, 422,
   * `host_not_connected`, …). This is *not* absence: the event may well exist,
   * we were simply not allowed to look. Nothing may complete against it —
   * a caller that treated this as absence would skip a delete and commit
   * `calendar_state='deleted'` over a live event, or insert a duplicate.
   */
  | { state: 'refused'; error: unknown }
  | { state: 'ambiguous'; error: unknown };

/**
 * `events.get` decides whether an **event exists** — never whether an attempt
 * finished (C6.3a / REV5-01). An event counts as this booking's only when it
 * carries the booking's `marloBookingId`.
 *
 * Only the documented absence responses (404/410, which the adapter maps to
 * `null`) establish absence. Every other definite refusal is `refused`: the
 * distinction C6.0 draws between "the request provably did nothing" and "the
 * resource is provably not there".
 */
export async function observeId(
  ctx: LifecycleContext,
  bookingId: string,
  eventId: string,
): Promise<Observation> {
  try {
    const event = await ctx.calendar.get({ calendarId: ctx.calendarId, eventId });
    if (event === null) {
      return { state: 'absent' };
    }
    if (event.marloBookingId !== undefined && event.marloBookingId !== bookingId) {
      // Someone else's event under our intended id: not ours to complete against.
      return { state: 'absent' };
    }
    return { state: 'present', event };
  } catch (error) {
    const klass = classifyCalendarError(error);
    if (klass === DEFINITE) {
      if (isAbsenceStatus(error)) {
        // 404/410 reached here rather than through the adapter's `null`.
        return { state: 'absent' };
      }
      return { state: 'refused', error };
    }
    return { state: 'ambiguous', error };
  }
}

/**
 * C6.2 — what an insert's own 2xx is allowed to establish.
 *
 * An insert response may complete an operation only when it actually
 * identifies the event the operation intended: the id we supplied, and (when
 * the response echoes it) this booking's `marloBookingId`. Anything else — a
 * body naming a different id, or one attributed to another booking — is not a
 * verified event, and the outcome is decided by the shared `events.get`
 * observation instead of by the insert status (REVIEW-05). A malformed 2xx
 * never reaches here at all: the adapter classifies it `ambiguous` (C6.0).
 */
export async function verifyInsert(
  ctx: LifecycleContext,
  bookingId: string,
  eventId: string,
  inserted: { id: string; etag: string; marloBookingId?: string },
): Promise<Observation> {
  if (
    inserted.id === eventId &&
    inserted.etag !== '' &&
    (inserted.marloBookingId === undefined || inserted.marloBookingId === bookingId)
  ) {
    return { state: 'present', event: inserted as CalendarEvent };
  }
  return observeId(ctx, bookingId, eventId);
}

/**
 * True when the read established **nothing** — it was refused or ambiguous.
 *
 * Both cases mean the same thing to a lifecycle step: it may not complete, may
 * not abandon, and may not treat the id as absent. The op stays owned and the
 * caller answers 503 `booking_outcome_unknown`, which is the honest report.
 */
export function unobserved(
  observation: Observation,
): observation is Extract<Observation, { state: 'refused' | 'ambiguous' }> {
  return observation.state === 'refused' || observation.state === 'ambiguous';
}

/**
 * C6.3c — a takeover's first Google mutation. It changes the event's etag, so
 * every `If-Match` the predecessor holds is stale and its delayed move,
 * compensation, or delete gets 412 and reconciles instead of landing.
 */
export type BumpResult =
  | { state: 'bumped'; etag: string }
  | { state: 'absent' }
  | { state: 'ambiguous'; error: unknown };

export async function bumpVersion(
  ctx: LifecycleContext,
  row: BookingRow,
  op: PendingOp,
  eventId: string,
): Promise<BumpResult> {
  const observed = await observeId(ctx, row.id, eventId);
  if (observed.state === 'absent') {
    // Nothing exists for the predecessor to patch; its insert attempts are
    // governed by C6.3a.
    return { state: 'absent' };
  }
  if (unobserved(observed)) {
    // Refused reads are not absence: the takeover stops rather than proceed
    // against an event it could not see.
    return { state: 'ambiguous', error: observed.error };
  }

  const attempt = newAttempt('bump', eventId, op.gen, ctx.clock, observed.event.etag);
  if (!(await writeAttempt(ctx, row, op, attempt))) {
    throw new SupersededError(row.id);
  }
  try {
    const patched = await ctx.calendar.patch({
      calendarId: ctx.calendarId,
      eventId,
      ifMatch: observed.event.etag,
      sendUpdates: 'none',
      opGen: `${op.opId}:${op.gen}`,
    });
    await finishAttempt(ctx, row, op, attempt.attemptId, 'applied');
    logLifecycle('version_bumped', { bookingId: row.id, eventId, opId: op.opId, gen: op.gen });
    return { state: 'bumped', etag: patched.etag };
  } catch (error) {
    const klass = classifyCalendarError(error);
    if (klass === 'precondition_failed') {
      // The etag already differs from anything the predecessor could hold:
      // re-observe once and proceed.
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      const again = await observeId(ctx, row.id, eventId);
      if (again.state === 'present') {
        return { state: 'bumped', etag: again.event.etag };
      }
      if (again.state === 'absent') {
        return { state: 'absent' };
      }
      return { state: 'ambiguous', error: again.error };
    }
    if (klass === DEFINITE && isAbsenceStatus(error)) {
      // Only 404/410 means the event is not there for the predecessor to patch.
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      return { state: 'absent' };
    }
    // Ambiguous (incl. 429): the takeover stops and keeps `pending_op`.
    return { state: 'ambiguous', error };
  }
}

export type AcquiredOp =
  /** Ownership acquired: `op` is this worker's, `row` is the locked snapshot. */
  | { state: 'taken'; op: PendingOp; row: BookingRow }
  /** Someone else owns it right now — non-terminal, nothing written. */
  | { state: 'busy'; retryAfterSeconds: number }
  /** No op of the requested kind is on the row any more. */
  | { state: 'gone' };

/**
 * C6.3 — **acquires** ownership of a stale op, deciding both staleness and the
 * op's identity from the row read **inside** the takeover transaction.
 *
 * A snapshot taken before the lock establishes only that the op *was* stale.
 * Two retries can both read generation 1 as stale; if the second then took over
 * whatever generation it found under the lock, it would immediately steal the
 * generation 2 the first had just established and renewed — two live owners of
 * one operation, which is exactly what the stale window exists to prevent.
 *
 * This is **acquisition**, never resumption: a caller that already owns the op
 * (it took it over itself, or inherited it) must not call this — bumping the
 * generation again would invalidate its own ownership.
 */
export async function acquireStaleOp(
  ctx: LifecycleContext,
  row: BookingRow,
  kinds: readonly OpKind[],
): Promise<AcquiredOp> {
  return ctx.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null || !kinds.includes(fresh.pendingOp.kind)) {
      return { state: 'gone' as const };
    }
    const now = ctx.clock.now();
    if (!isStaleOp(fresh.pendingOp, now)) {
      // Renewed between the snapshot and this lock: still owned elsewhere.
      return { state: 'busy' as const, retryAfterSeconds: retryAfterSeconds(fresh.pendingOp, now) };
    }
    const taken = await takeOverOp(tx, fresh, fresh.pendingOp, ctx.clock);
    if (taken === null) {
      return { state: 'busy' as const, retryAfterSeconds: 1 };
    }
    return { state: 'taken' as const, op: taken, row: fresh };
  });
}

/** C6.3 takeover: `gen+1`, conditioned on opId/gen. */
export async function takeOverOp(
  tx: BookingTx,
  row: BookingRow,
  op: PendingOp,
  clock: Clock,
): Promise<PendingOp | null> {
  const ok = await tx.takeOver(
    row.id,
    op.opId,
    op.gen,
    new Date(clock.now()).toISOString(),
  );
  if (!ok) {
    return null;
  }
  const taken = cloneOp(op);
  taken.gen = op.gen + 1;
  taken.startedAt = new Date(clock.now()).toISOString();
  return taken;
}

export { classifyCalendarError, AlreadyExistsError, CalendarError, PreconditionFailedError };
export type { CalendarOutcomeClass };
export const OUTCOME_APPLIED = APPLIED;
export const OUTCOME_AMBIGUOUS = AMBIGUOUS;
export const OUTCOME_DEFINITE = DEFINITE;
