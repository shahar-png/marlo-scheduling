// C6.3a — the superseded worker.
//
// Two determinations, made from **one locked read** and kept strictly apart
// (REV7-01, the rule the rev-7 wording violated):
//
//  (1) **Response.** Did the winner reach what I was trying to reach? For a
//      create that is decided by `createFinalized()` — immutable identity,
//      `latest_action IS NOT NULL`, and my create op cleared — never by
//      `latest_action`'s *value*, `status`, `start`, `revision`, or
//      `calendar_state` (REV9-01, REV15-02).
//
//  (2) **Cleanup eligibility of my own attempt**, never inferred from the row's
//      interval: an id that is **live** is not eligible *even when the booking
//      no longer matches my target* — the winner adopted the event and may
//      since have moved it under that same id. An id still **intended by an
//      open op** is not eligible either. Only a **retired** id whose entry
//      still retains my `attemptId` is.
//
// The observed-etag retry after 412 exists only inside that eligibility, which
// is safe precisely because retired is absorbing (REV5-02).

import { classifyCalendarError, DEFINITE, isAbsenceStatus } from '../google/errors';
import { createFinalized, createReplacedUnfinished, takeoverRunning, type CreateOpIdentity } from './create-identity';
import { logLifecycle } from './log';
import type { LifecycleContext } from './ops';
import {
  isLiveId,
  openOpIntendedIds,
  retryAfterSeconds,
  type BookingRow,
  type PendingOp,
} from './rows';

export type SupersededResponse =
  | 'success'
  | 'operation_in_progress'
  | 'operation_superseded';

export type SupersededDecision = {
  response: SupersededResponse;
  /** Present when the response is `operation_in_progress`. */
  retryAfterSeconds?: number;
  /** The row as read under the lock; `null` only when it vanished. */
  row: BookingRow | null;
  /** (2): may this worker delete its OWN attributed event? */
  eligible: boolean;
};

/**
 * The insert this worker actually issued. `op.attempts` is a **local** snapshot
 * taken before the mutation, so a worker whose attempt was persisted by
 * `writeAttempt` (a reschedule's fallback insert, a repair's insert) does not
 * find it there — passing the ids explicitly is what makes eligibility decidable
 * for those paths instead of silently `false` (REV-02).
 */
export type OwnInsertRef = { attemptId: string; eventId: string };

export type SupersededInput = { ownInsert?: OwnInsertRef } & (
  | { kind: 'create'; op: PendingOp; identity: CreateOpIdentity; bookingId: string }
  | { kind: 'reschedule'; op: PendingOp; bookingId: string; target: string }
  | { kind: 'cancel'; op: PendingOp; bookingId: string }
  | { kind: 'calendar_repair'; op: PendingOp; bookingId: string }
);

export async function reconcileSuperseded(
  ctx: LifecycleContext,
  input: SupersededInput,
  /** The host the booking belongs to — the lock eligibility is decided under. */
  hostId: string,
): Promise<SupersededDecision> {
  // C6.3a: both determinations come from **one locked read**. An unlocked read
  // could observe the row mid-transition and call a retired id live (or the
  // reverse), and eligibility is exactly the decision that must not be wrong.
  const row = await ctx.store.withHostLock(hostId, (tx) => tx.selectForUpdate(input.bookingId));
  if (row === null) {
    return { response: 'operation_superseded', row: null, eligible: false };
  }

  const eligible = cleanupEligible(row, input.op, input.ownInsert);
  const response = decideResponse(ctx, row, input);

  if (response.response === 'operation_superseded') {
    logLifecycle('operation_superseded', {
      bookingId: row.id,
      opId: input.op.opId,
      gen: input.op.gen,
      kind: input.kind,
    });
  }

  return { ...response, row, eligible };
}

function decideResponse(
  ctx: LifecycleContext,
  row: BookingRow,
  input: SupersededInput,
): { response: SupersededResponse; retryAfterSeconds?: number } {
  if (input.kind === 'create') {
    if (createFinalized(row, input.identity)) {
      // The booking is a finalized business record, whatever has happened to
      // it since: the answer is the calling route's success status (201).
      return { response: 'success' };
    }
    if (takeoverRunning(row, input.identity)) {
      // My opId under a higher gen: the takeover is still running. Non-terminal
      // so the client keeps its key and replays into the completed booking.
      return {
        response: 'operation_in_progress',
        retryAfterSeconds:
          row.pendingOp === null ? 1 : retryAfterSeconds(row.pendingOp, ctx.clock.now()),
      };
    }
    if (createReplacedUnfinished(row, input.identity)) {
      // The one branch where "my op is no longer named" does NOT mean "my
      // booking was created": a C6.7 cancel replaced it without completing it.
      // Never 201 (the envelope could only read `calendar: 'pending'`), never
      // `operation_superseded`, never terminal (REV14-01).
      return {
        response: 'operation_in_progress',
        retryAfterSeconds:
          row.pendingOp === null ? 1 : retryAfterSeconds(row.pendingOp, ctx.clock.now()),
      };
    }
    // Unreachable by construction — ids are app-generated and the identity
    // columns immutable. Kept as the defensive branch.
    logLifecycle('create_identity_mismatch', {
      bookingId: row.id,
      opId: input.op.opId,
    });
    return { response: 'operation_superseded' };
  }

  if (input.kind === 'reschedule') {
    const reached =
      row.status === 'confirmed' &&
      row.revision > 1 &&
      row.start === input.target;
    return { response: reached ? 'success' : 'operation_superseded' };
  }

  if (input.kind === 'cancel') {
    return {
      response: row.status === 'cancelled' ? 'success' : 'operation_superseded',
    };
  }

  // A repair reached its target when the calendar event exists again.
  return {
    response: row.calendarState === 'created' ? 'success' : 'operation_superseded',
  };
}

/** (2) — eligibility, decided by the id's state and nothing else. */
export function cleanupEligible(
  row: BookingRow,
  op: PendingOp,
  ownInsert?: OwnInsertRef,
): boolean {
  // The worker's *own* attempt when it named one; otherwise the op's intended id
  // and whatever attempt the local ledger snapshot holds for it.
  const intended =
    ownInsert?.eventId ?? (op.kind === 'reschedule' ? op.fallbackEventId : op.eventId);
  if (intended === undefined) {
    return false;
  }
  if (isLiveId(row, intended)) {
    // The winner adopted the event and may since have moved it under this same
    // id: the event under it IS the booking's event.
    return false;
  }
  if (openOpIntendedIds(row).includes(intended)) {
    // The winner may yet adopt it.
    return false;
  }
  const attemptId =
    ownInsert?.attemptId ??
    op.attempts.find((attempt) => attempt.kind === 'insert' && attempt.eventId === intended)
      ?.attemptId;
  if (attemptId === undefined) {
    return false;
  }
  // Retired, and my attempt is still retained → mine to remove.
  return row.unresolvedInserts.some((entry) => entry.attemptId === attemptId);
}

/**
 * Cleanup of a superseded worker's **own attributed event**, permitted only for
 * an eligible attempt and only on a **definite 2xx** insert response — the one
 * thing that resolves *this* attempt (C6.3b).
 */
export async function cleanupOwnEvent(
  ctx: LifecycleContext,
  bookingId: string,
  eventId: string,
  attemptId: string,
  insertEtag: string,
): Promise<{ deleted: boolean }> {
  try {
    await ctx.calendar.remove({
      calendarId: ctx.calendarId,
      eventId,
      ifMatch: insertEtag,
      sendUpdates: 'none',
    });
    await ctx.store.retireAttempt(bookingId, attemptId);
    logLifecycle('event_reaped', { bookingId, eventId, attemptId });
    return { deleted: true };
  } catch (error) {
    const klass = classifyCalendarError(error);
    if (klass !== 'precondition_failed') {
      // Retirement requires **proof** that the event is gone (C6.0/C6.3a): a
      // 404/410 means a reaper already deleted it and attributed the same
      // `attemptId`, so retiring is a no-op either way. A 403, a 429, a 5xx, or
      // a network failure proves nothing — the event may still be on the host's
      // calendar, and dropping its only cleanup reference would strand it
      // there forever (LIVE-REVIEW-05). The entry stays listed for the reap.
      if (klass === DEFINITE && isAbsenceStatus(error)) {
        await ctx.store.retireAttempt(bookingId, attemptId);
      }
      return { deleted: false };
    }
  }

  // 412 → observe once.
  let observed;
  try {
    observed = await ctx.calendar.get({ calendarId: ctx.calendarId, eventId });
  } catch {
    return { deleted: false };
  }
  if (observed === null) {
    await ctx.store.retireAttempt(bookingId, attemptId);
    return { deleted: false };
  }
  if (observed.marloAttemptId !== attemptId) {
    // My own event is already gone; delete nothing with a stale etag.
    await ctx.store.retireAttempt(bookingId, attemptId);
    return { deleted: false };
  }
  // My own attribution with a new etag (a version bump): one retry. Safe only
  // because eligibility was determined under the lock and retired is absorbing.
  try {
    await ctx.calendar.remove({
      calendarId: ctx.calendarId,
      eventId,
      ifMatch: observed.etag,
      sendUpdates: 'none',
    });
    await ctx.store.retireAttempt(bookingId, attemptId);
    logLifecycle('event_reaped', { bookingId, eventId, attemptId });
    return { deleted: true };
  } catch (error) {
    // Same rule as the first delete: only proven absence retires the entry.
    if (classifyCalendarError(error) === DEFINITE && isAbsenceStatus(error)) {
      await ctx.store.retireAttempt(bookingId, attemptId);
    }
    return { deleted: false };
  }
}

/** A 409/4xx insert response means this worker created nothing (C6.3a). */
export async function retireWithoutDelete(
  ctx: LifecycleContext,
  bookingId: string,
  attemptId: string,
): Promise<void> {
  await ctx.store.retireAttempt(bookingId, attemptId);
}
