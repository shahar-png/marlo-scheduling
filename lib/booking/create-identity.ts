// REV15-02 — the ONE finalization predicate.
//
// `createFinalized()` is the single implementation behind C6.3a(1)(ii), the
// C6.4 **L0** lookup, and the C9 same-key replay, so those three can never
// disagree about whether a booking exists.
//
// It tests, and only tests:
//   (i)  the **immutable create identity** — `owner_id`, `idempotency_key`,
//        `create_fingerprint` (all written once in T1 and never updated) plus
//        the app-generated `id`;
//   (ii) `latest_action IS NOT NULL` — the C6.4a finalization witness; and
//  (iii) the create op cleared (`pending_op IS NULL OR opId <> mine`).
//
// The rev-9 prohibition, stated precisely: no predicate may compare
// `latest_action` against a **particular value** (`= 'confirm'`, which a later
// reschedule or cancel legitimately falsifies), while testing its **monotonic
// nullness** is required — nullness is the only durable fact that separates a
// create someone *finalized* from one a C6.7 cancel merely *replaced*.

import type { BookingRow } from './rows';

export type CreateOpIdentity = {
  opId: string;
  ownerId: string;
  idempotencyKey: string;
  createFingerprint: string;
  bookingId: string;
};

export function createIdentityMatches(row: BookingRow, op: CreateOpIdentity): boolean {
  return (
    row.id === op.bookingId &&
    row.ownerId === op.ownerId &&
    row.idempotencyKey === op.idempotencyKey &&
    row.createFingerprint === op.createFingerprint
  );
}

/** (iii) — the rev-9 clearing test, kept verbatim. */
export function createOpCleared(row: BookingRow, opId: string): boolean {
  return row.pendingOp === null || row.pendingOp.opId !== opId;
}

/** (ii) — C6.4a: monotonic nullness, never a value comparison. */
export function creationFinalized(row: BookingRow): boolean {
  return row.latestAction !== null;
}

export function createFinalized(row: BookingRow, op: CreateOpIdentity): boolean {
  return (
    createIdentityMatches(row, op) && creationFinalized(row) && createOpCleared(row, op.opId)
  );
}

/**
 * The row still names this `opId` under a **higher** gen: the takeover is
 * running, so the answer is the non-terminal `operation_in_progress`, never
 * `operation_superseded` (REV9-01).
 */
export function takeoverRunning(row: BookingRow, op: CreateOpIdentity): boolean {
  return row.pendingOp !== null && row.pendingOp.opId === op.opId;
}

/**
 * Identity matches but the creation is **unfinished** under someone else's op
 * (the C6.7 cancel that replaced it) or under a restored one: the one branch in
 * which "my op is no longer named" does NOT mean "my booking was created"
 * (REV14-01). Also non-terminal.
 */
export function createReplacedUnfinished(row: BookingRow, op: CreateOpIdentity): boolean {
  if (!createIdentityMatches(row, op) || creationFinalized(row)) {
    return false;
  }
  return (
    row.unfinishedCreate !== null ||
    (row.pendingOp !== null && row.pendingOp.opId !== op.opId)
  );
}
