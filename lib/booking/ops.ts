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
  type CalendarOutcomeClass,
} from '../google/errors';
import type { CalendarClient, CalendarEvent, SendUpdates } from '../google/calendar';
import { newAttemptId } from './ids';
import { logLifecycle } from './log';
import type { BookingStore, BookingTx } from './store';
import {
  cloneOp,
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

export type Observation =
  | { state: 'present'; event: CalendarEvent }
  | { state: 'absent' }
  | { state: 'ambiguous'; error: unknown };

/**
 * `events.get` decides whether an **event exists** — never whether an attempt
 * finished (C6.3a / REV5-01). An event counts as this booking's only when it
 * carries the booking's `marloBookingId`.
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
      // A definite 4xx on a read still tells us nothing exists for us.
      return { state: 'absent' };
    }
    return { state: 'ambiguous', error };
  }
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
  if (observed.state === 'ambiguous') {
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
    if (klass === DEFINITE) {
      await finishAttempt(ctx, row, op, attempt.attemptId, 'rejected');
      return { state: 'absent' };
    }
    // Ambiguous (incl. 429): the takeover stops and keeps `pending_op`.
    return { state: 'ambiguous', error };
  }
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
