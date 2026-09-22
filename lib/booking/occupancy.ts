// C6.1 occupancy and C7 busy classification — the ONE definition every
// conflict, capacity, and availability query in the live path uses, so there is
// no second occupancy rule to drift from (REV9-02's single `hostOccupancy`).
//
// Occupancy for a host is the union of
//   (a) every `status='confirmed'` row of that host and its `[start, end)` —
//       including a row whose reschedule has not completed, whose OLD interval
//       is retained until T2 releases it; and
//   (b) every non-null `[reserved_start, reserved_end)` written by a reschedule
//       T1 — the destination is reserved durably.
// Occupancy is **single-host and exclusive**: group capacity is out of LIVE-INT
// (Product bar lock, C6.9).
//
// The one and only exclusion is *the booking's own* interval, reservation, and
// managed event during its own reschedule (AC-8).

import { AvailabilityUnknownError } from '../google/errors';
import { isBusyCandidate, isManaged, type CalendarListItem } from '../google/calendar';
import { logLifecycle } from './log';
import type { LifecycleContext } from './ops';
import {
  eligibleReapIds,
  orderReapCandidates,
  overlaps,
  REAP_MAX_PER_REQUEST,
  type BookingRow,
  type Interval,
} from './rows';
import type { BookingStore } from './store';

export type OccupancyOptions = {
  excludeBookingId?: string;
};

export async function hostOccupancy(
  store: BookingStore,
  hostId: string,
  window: Interval,
  options: OccupancyOptions = {},
): Promise<Interval[]> {
  return store.occupancy({
    hostId,
    window,
    ...(options.excludeBookingId === undefined
      ? {}
      : { excludeBookingId: options.excludeBookingId }),
  });
}

export type ManagedMatch = {
  row: BookingRow;
  /** True when the item's id is a retired id of its row (reap-eligible). */
  retired: boolean;
};

export type ClassifiedBusy = {
  busy: Interval[];
  /** Retired-id items observed in this read, ready for the bounded reap. */
  reapCandidates: {
    bookingId: string;
    hostId: string;
    eventId: string;
    etag: string;
    attemptId: string | undefined;
  }[];
};

/**
 * C7. A managed item is excluded from external busy **only when the store
 * accounts for it**: its `marloBookingId` resolves to a row whose current
 * interval — or whose reservation — equals the item's. An unmatched or
 * displaced managed item is conservatively busy at its *actual* interval, and
 * the store's own occupancy for that row is still counted too, so a
 * host-moved event blocks both intervals (REV3-10).
 */
export function classifyBusy(
  items: CalendarListItem[],
  resolve: (bookingId: string) => BookingRow | null,
  options: { excludeBookingId?: string } = {},
): ClassifiedBusy {
  const busy: Interval[] = [];
  const reapCandidates: ClassifiedBusy['reapCandidates'] = [];

  for (const item of items) {
    if (!isBusyCandidate(item)) {
      // Cancelled or transparent: never busy.
      continue;
    }
    const interval: Interval = { start: item.start, end: item.end };

    if (!isManaged(item)) {
      busy.push(interval);
      continue;
    }

    const row = resolve(item.marloBookingId as string);
    if (row === null || row.status === 'cancelled') {
      if (row !== null && options.excludeBookingId === row.id) {
        // The booking's own managed event during its own reschedule.
        continue;
      }
      if (row !== null && isRetiredId(row, item.id)) {
        reapCandidates.push({
          bookingId: row.id,
          hostId: row.hostId,
          eventId: item.id,
          etag: item.etag,
          attemptId: item.marloAttemptId,
        });
      }
      // Unmatched managed item: conservatively busy at its actual interval.
      busy.push(interval);
      continue;
    }

    if (options.excludeBookingId === row.id) {
      continue;
    }

    if (isRetiredId(row, item.id)) {
      // A late-landed insert of a superseded or timed-out attempt: busy for
      // THIS request whether or not the reap succeeds, so it can never
      // free-ride into a double booking (C6.3a).
      reapCandidates.push({
        bookingId: row.id,
        hostId: row.hostId,
        eventId: item.id,
        etag: item.etag,
        attemptId: item.marloAttemptId,
      });
      busy.push(interval);
      continue;
    }

    if (accountsFor(row, interval)) {
      // Matched: the store already counts this occupancy (C6.1).
      continue;
    }

    // Displaced (the host moved it by hand): busy at its actual interval.
    busy.push(interval);
  }

  return { busy, reapCandidates };
}

/** An id is retired when an entry names it and it is not the row's live id. */
function isRetiredId(row: BookingRow, eventId: string): boolean {
  if (row.status === 'confirmed' && row.googleEventId === eventId) {
    return false;
  }
  return row.unresolvedInserts.some((entry) => entry.eventId === eventId);
}

function accountsFor(row: BookingRow, interval: Interval): boolean {
  if (row.start === interval.start && row.end === interval.end) {
    return true;
  }
  return (
    row.reservedStart === interval.start && row.reservedEnd === interval.end
  );
}

/**
 * The R0 external-availability read (C6.4 / C6.6 / REV6-03). Runs **outside any
 * transaction and lock**, before T1; fail-closed on any unparseable page.
 */
export async function externalBusy(
  ctx: LifecycleContext,
  input: { window: Interval; excludeBookingId?: string; timeZone?: string },
): Promise<Interval[]> {
  let items: CalendarListItem[];
  try {
    items = await ctx.calendar.list({
      calendarId: ctx.calendarId,
      timeMin: input.window.start,
      timeMax: input.window.end,
      ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    });
  } catch (error) {
    if (error instanceof AvailabilityUnknownError) {
      throw error;
    }
    // Any other read failure is equally fail-closed — never "free" (AC-7).
    throw new AvailabilityUnknownError(error instanceof Error ? error.message : String(error));
  }

  const rows = new Map<string, BookingRow | null>();
  for (const item of items) {
    if (isManaged(item)) {
      const bookingId = item.marloBookingId as string;
      if (!rows.has(bookingId)) {
        rows.set(bookingId, await ctx.store.findByBookingIdForReap(bookingId));
      }
    }
  }

  const classified = classifyBusy(items, (bookingId) => rows.get(bookingId) ?? null, {
    ...(input.excludeBookingId === undefined
      ? {}
      : { excludeBookingId: input.excludeBookingId }),
  });

  // Reap-on-observation, bounded per request and in C6.3a's fair order. The
  // items are already in hand, so no `events.get` is needed.
  await reapListedItems(ctx, classified.reapCandidates);

  return classified.busy;
}

export async function reapListedItems(
  ctx: LifecycleContext,
  candidates: ClassifiedBusy['reapCandidates'],
  max = REAP_MAX_PER_REQUEST,
): Promise<string[]> {
  if (candidates.length === 0) {
    return [];
  }
  // Fair order per row, then a global cap on deletes for this request.
  const byRow = new Map<string, ClassifiedBusy['reapCandidates']>();
  for (const candidate of candidates) {
    const list = byRow.get(candidate.bookingId) ?? [];
    list.push(candidate);
    byRow.set(candidate.bookingId, list);
  }

  const chosen: ClassifiedBusy['reapCandidates'] = [];
  for (const [bookingId, list] of byRow) {
    const row = await ctx.store.findByBookingIdForReap(bookingId);
    if (row === null) {
      continue;
    }
    const eligible = eligibleReapIds(row).filter((eventId) =>
      list.some((candidate) => candidate.eventId === eventId),
    );
    const ordered = orderReapCandidates(row, eligible);
    for (const eventId of ordered) {
      const candidate = list.find((entry) => entry.eventId === eventId);
      if (candidate !== undefined && chosen.length < max) {
        chosen.push(candidate);
      }
    }
  }

  const deleted: string[] = [];
  for (const candidate of chosen) {
    // `inspectSeq` is stamped under the host lock before the Google call, from
    // the row's monotonic `reap_cursor` — exactly as the C6.3a reap does.
    await ctx.store.stampReapBatch(
      candidate.bookingId,
      [candidate.eventId],
      new Date(ctx.clock.now()).toISOString(),
    );
    try {
      await ctx.calendar.remove({
        calendarId: ctx.calendarId,
        eventId: candidate.eventId,
        ifMatch: candidate.etag,
        sendUpdates: 'none',
      });
    } catch {
      // Bounded best-effort cleanup: a contended delete is retried by the next
      // observing call. The interval was already reported busy for this one.
      continue;
    }
    deleted.push(candidate.eventId);
    if (candidate.attemptId !== undefined) {
      await ctx.store.retireAttempt(candidate.bookingId, candidate.attemptId);
      logLifecycle('event_reaped', {
        bookingId: candidate.bookingId,
        eventId: candidate.eventId,
        attemptId: candidate.attemptId,
      });
    }
  }
  return deleted;
}

export function busyOverlaps(window: Interval, busy: Interval[]): boolean {
  return busy.some((interval) => overlaps(interval, window));
}
