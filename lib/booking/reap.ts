// C6.3a — the reap of **retired** ids.
//
// One procedure, callable by any worker, needing no ownership: a retired id can
// never be adopted (retired is absorbing, REV5-02), so deleting an event under
// one can only remove something nobody will ever claim.
//
// Two invariants this file exists to keep:
//   * **attribution** — a deletion retires exactly the attempt the deleted
//     event names through `marloAttemptId`, never the oldest and never an
//     unidentified one, and retirement is idempotent by `attemptId` (REV6-01);
//   * **fair traversal** — the batch is ordered by `inspectSeq`, drawn from the
//     row's monotonic `reap_cursor` and stamped under the same host lock that
//     selected the batch, *before* any Google call. The traversal therefore
//     advances strictly however the clock behaves (REV13-01).
//
// The reap is bounded best-effort **cleanup**: its ambiguous outcomes block
// nothing and it is never a precondition of any T2 (REV6-02).

import { classifyCalendarError } from '../google/errors';
import { logLifecycle } from './log';
import type { LifecycleContext } from './ops';
import {
  eligibleReapIds,
  orderReapCandidates,
  REAP_MAX_PER_REQUEST,
  type BookingRow,
} from './rows';

export type ReapReport = {
  /** Ids inspected in this request, in batch order. */
  inspected: string[];
  /** Ids whose event was deleted in this request. */
  deleted: string[];
  /** `attemptId`s retired in this request. */
  retired: string[];
  /** `inspectSeq` values stamped for the batch, in batch order. */
  stamped: number[];
};

const EMPTY: ReapReport = { inspected: [], deleted: [], retired: [], stamped: [] };

/**
 * Selects this request's batch and stamps it — both inside ONE locked
 * transaction, before any Google call, so two concurrent reapers are
 * serialized by the host lock and the second one's batch begins with exactly
 * the ids the first did not take.
 */
export async function selectBatch(
  ctx: LifecycleContext,
  bookingId: string,
  max = REAP_MAX_PER_REQUEST,
): Promise<{ batch: string[]; stamped: number[] }> {
  const row = await ctx.store.getById(bookingId);
  if (row === null) {
    return { batch: [], stamped: [] };
  }
  return ctx.store.withHostLock(row.hostId, async (tx) => {
    // The eligible set is computed in the SAME read that decides `status` and
    // `google_event_id` — never from an earlier snapshot (C6.3a).
    const fresh = await tx.selectForUpdate(bookingId);
    if (fresh === null) {
      return { batch: [], stamped: [] };
    }
    const eligible = eligibleReapIds(fresh);
    if (eligible.length === 0) {
      return { batch: [], stamped: [] };
    }
    const batch = orderReapCandidates(fresh, eligible).slice(0, max);
    const stamped = await tx.stampReapBatch(
      bookingId,
      batch,
      new Date(ctx.clock.now()).toISOString(),
    );
    return { batch, stamped };
  });
}

/**
 * The full reap: select + stamp under the lock, then inspect each batched id
 * outside it. Returns what it inspected and deleted; it never throws for a
 * Google failure, because cleanup must not block the caller's operation.
 */
export async function reapRetiredIds(
  ctx: LifecycleContext,
  bookingId: string,
  max = REAP_MAX_PER_REQUEST,
): Promise<ReapReport> {
  const { batch, stamped } = await selectBatch(ctx, bookingId, max);
  if (batch.length === 0) {
    return EMPTY;
  }
  const report: ReapReport = { inspected: [...batch], deleted: [], retired: [], stamped };

  for (const eventId of batch) {
    await reapOne(ctx, bookingId, eventId, report);
  }
  return report;
}

async function reapOne(
  ctx: LifecycleContext,
  bookingId: string,
  eventId: string,
  report: ReapReport,
): Promise<void> {
  let observed;
  try {
    observed = await ctx.calendar.get({ calendarId: ctx.calendarId, eventId });
  } catch {
    // Ambiguous get: nothing changes — every entry may still land.
    return;
  }
  if (observed === null) {
    // Definitely absent: nothing changes (the attempt may still execute).
    return;
  }
  if (observed.marloBookingId !== undefined && observed.marloBookingId !== bookingId) {
    // Not this row's event; never touched here.
    return;
  }

  const attributedTo = observed.marloAttemptId;
  try {
    await ctx.calendar.remove({
      calendarId: ctx.calendarId,
      eventId,
      ifMatch: observed.etag,
      sendUpdates: 'none',
    });
    report.deleted.push(eventId);
    await retire(ctx, bookingId, attributedTo, eventId, report);
    return;
  } catch (error) {
    if (classifyCalendarError(error) !== 'precondition_failed') {
      // Definite 4xx or ambiguous: nothing is retired by a deletion that did
      // not provably remove an attributed event.
      return;
    }
  }

  // 412 → one more `events.get` (C6.3a).
  let again;
  try {
    again = await ctx.calendar.get({ calendarId: ctx.calendarId, eventId });
  } catch {
    return;
  }
  if (again === null) {
    // Gone between our two reads: the event we observed no longer exists, so
    // the attempt that created it provably executed.
    await retire(ctx, bookingId, attributedTo, eventId, report);
    return;
  }
  if (again.marloAttemptId !== attributedTo) {
    // A *different* request's event now occupies the id: our observed event
    // existed and is gone. Retire that attempt; never delete with a stale etag.
    await retire(ctx, bookingId, attributedTo, eventId, report);
    return;
  }
  // Same attribution, new etag (a version bump): one delete retry.
  try {
    await ctx.calendar.remove({
      calendarId: ctx.calendarId,
      eventId,
      ifMatch: again.etag,
      sendUpdates: 'none',
    });
    report.deleted.push(eventId);
    await retire(ctx, bookingId, attributedTo, eventId, report);
  } catch {
    // Still contended: leave it for the next observing call.
  }
}

async function retire(
  ctx: LifecycleContext,
  bookingId: string,
  attemptId: string | undefined,
  eventId: string,
  report: ReapReport,
): Promise<void> {
  if (attemptId === undefined) {
    // A managed event carrying no `marloAttemptId` — nothing this PLAN issues.
    // It is deleted (above) but retires nothing.
    logLifecycle('event_reaped', { bookingId, eventId, attemptId: null });
    return;
  }
  await ctx.store.retireAttempt(bookingId, attemptId);
  report.retired.push(attemptId);
  logLifecycle('event_reaped', { bookingId, eventId, attemptId });
}

/** Shared by cancel, notify, reads, and C7 — the one idempotent retirement. */
export async function retireAttempt(
  ctx: LifecycleContext,
  bookingId: string,
  attemptId: string,
): Promise<void> {
  await ctx.store.retireAttempt(bookingId, attemptId);
}

/** True when this row has anything for the reap to do (C6.3a trigger). */
export function hasEligibleReap(row: BookingRow): boolean {
  return eligibleReapIds(row).length > 0;
}
