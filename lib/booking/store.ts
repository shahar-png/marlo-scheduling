// The durable booking store seam (C6, C8). The lifecycle modules talk to this
// interface only, so `MemoryBookingStore` and `PgBookingStore` cannot drift —
// every C6 rule is written once and proved against both (AC-3).
//
// The unit of serialization is `withHostLock`: one transaction holding the
// per-host advisory lock (`pg_advisory_xact_lock(hashtext(hostId))` in pg, a
// per-host async mutex in memory). The lock is **never** held across a Google
// call; durable reservations (C6.1) make that unnecessary.

import type {
  Attempt,
  BookingRow,
  CalendarState,
  Interval,
  LatestAction,
  PendingOp,
  RejectionReason,
  UnfinishedCreate,
  UnresolvedInsert,
} from './rows';

export type DeliveryRecipient = 'invitee' | 'owner';
export type DeliveryState = 'claimed' | 'sent' | 'failed';
export type DeliveryAction = LatestAction;

export type DeliveryRow = {
  bookingId: string;
  revision: number;
  action: DeliveryAction;
  recipient: DeliveryRecipient;
  state: DeliveryState;
  claimedAt: string;
  /** Doubles as the claim generation (C5 / REV2-06). */
  attempts: number;
};

export type NewBookingRow = {
  id: string;
  token: string;
  idempotencyKey: string;
  createFingerprint: string;
  ownerId: string;
  eventTypeId: string;
  hostId: string;
  start: string;
  end: string;
  googleEventId: string;
  pendingOp: PendingOp;
  inviteeName: string;
  inviteeEmail: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

/** Fields a conditional lifecycle update may write. */
export type RowPatch = {
  start?: string;
  end?: string;
  status?: 'cancelled';
  latestAction?: LatestAction;
  calendarState?: CalendarState;
  googleEventId?: string;
  googleEventEtag?: string | null;
  rescheduledFrom?: string | null;
  reservedStart?: string | null;
  reservedEnd?: string | null;
  pendingOp?: PendingOp | null;
  unfinishedCreate?: UnfinishedCreate | null;
  /** Replaces the retained list wholesale (computed by the caller). */
  unresolvedInserts?: UnresolvedInsert[];
  /** `revision + 1` when true — the only way revision moves. */
  bumpRevision?: boolean;
};

export type OwnedUpdate = {
  id: string;
  /** Every state-changing update is conditional on the revision. */
  expectedRevision: number;
  /** Most updates additionally require `status='confirmed'`. */
  requireConfirmed?: boolean;
  /** Completing / clearing / compensating updates require ownership (C6.3). */
  opId?: string;
  gen?: number;
  patch: RowPatch;
};

export type OccupancyQuery = {
  hostId: string;
  window: Interval;
  /** The booking's own occupancy is excluded only during its own reschedule. */
  excludeBookingId?: string;
};

/** One locked transaction. Every method issues real SQL in pg mode. */
export interface BookingTx {
  /** C9 / C6.4 L0 and T1's mandatory second lookup. */
  lookupKey(ownerId: string, idempotencyKey: string): Promise<BookingRow | null>;
  /** C6.4 rejection fence (REV8-01). */
  lookupRejection(
    ownerId: string,
    idempotencyKey: string,
    createFingerprint: string,
  ): Promise<RejectionReason | null>;
  insertRejection(input: {
    ownerId: string;
    idempotencyKey: string;
    createFingerprint: string;
    reason: RejectionReason;
  }): Promise<void>;
  insertBooking(row: NewBookingRow): Promise<BookingRow>;
  /** `SELECT … FOR UPDATE` — the read every lifecycle decision is made from. */
  selectForUpdate(id: string): Promise<BookingRow | null>;
  /** C6.1 occupancy: confirmed intervals ∪ non-null reservations. */
  occupancy(query: OccupancyQuery): Promise<Interval[]>;
  /** Returns false when zero rows matched: superseded or revision lost. */
  update(update: OwnedUpdate): Promise<boolean>;
  /** C6.3 takeover: `gen+1` conditioned on opId/gen. */
  takeOver(id: string, opId: string, gen: number, startedAt: string): Promise<boolean>;
  /** C6.3b attempt write — conditioned on opId/gen, committed before the call. */
  appendAttempt(id: string, opId: string, gen: number, attempt: Attempt): Promise<boolean>;
  /** Finalises an attempt from its OWN response (C6.3b). */
  resolveAttempt(
    id: string,
    opId: string,
    gen: number,
    attemptId: string,
    outcome: 'applied' | 'rejected',
    resolvedAt: string,
  ): Promise<boolean>;
  /** C6.3a: stamps `inspectSeq` from `reap_cursor` for one batch, under lock. */
  stampReapBatch(id: string, eventIds: string[], inspectedAt: string): Promise<number[]>;
  /** C6.3a: idempotent by `attemptId`; never touches another entry. */
  retireAttempt(id: string, attemptId: string): Promise<void>;
}

export type LedgerClaim = { gen: number } | null;

export interface BookingStore {
  /** One transaction with the per-host lock held (C6). */
  withHostLock<T>(hostId: string, fn: (tx: BookingTx) => Promise<T>): Promise<T>;
  /**
   * C6.5: reacquires the same host lock on a **fresh connection**, which
   * establishes that the original transaction has finished, and only then
   * reads. Rejects with `OutcomeUnresolvedError` when the lock cannot be
   * reacquired — the outcome stays unknown rather than being guessed.
   */
  withFinishedTransaction<T>(
    hostId: string,
    fn: (tx: BookingTx) => Promise<T>,
  ): Promise<T>;
  getById(id: string): Promise<BookingRow | null>;
  getByToken(token: string): Promise<BookingRow | null>;
  /** Unlocked occupancy read for the availability routes. */
  occupancy(query: OccupancyQuery): Promise<Interval[]>;
  /** Rows that name `eventId` in `unresolved_inserts` or as their live id. */
  findByGoogleEventId(eventId: string): Promise<BookingRow | null>;
  findByBookingIdForReap(bookingId: string): Promise<BookingRow | null>;
  retireAttempt(bookingId: string, attemptId: string): Promise<void>;
  stampReapBatch(bookingId: string, eventIds: string[], inspectedAt: string): Promise<number[]>;

  // ---- C5 delivery ledger ------------------------------------------------
  claimDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    nowMs: number;
  }): Promise<LedgerClaim>;
  finalizeDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    gen: number;
    state: 'sent' | 'failed';
  }): Promise<boolean>;
  deliveryRows(bookingId: string, revision: number, action: DeliveryAction): Promise<DeliveryRow[]>;
}

export class OutcomeUnresolvedError extends Error {
  readonly code = 'booking_outcome_unknown';
  constructor(
    readonly bookingId: string | null,
    readonly detail: string,
  ) {
    super(`booking_outcome_unknown: ${detail}`);
    this.name = 'OutcomeUnresolvedError';
  }
}
