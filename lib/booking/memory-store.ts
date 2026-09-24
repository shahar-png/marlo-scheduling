// In-memory `BookingStore` (AC-3). Observably identical to the pg store: the
// per-host async mutex stands in for `pg_advisory_xact_lock`, every update is
// the same conditional update, and the C5 claim predicate is the same one the
// SQL implements — `failed` re-claimable immediately, `claimed` only after the
// stale window (REV7-04).

import {
  cloneOp,
  cloneRow,
  orderReapCandidates,
  overlaps,
  type Attempt,
  type BookingRow,
  type Interval,
  type RejectionReason,
  CLAIM_STALE_MS,
} from './rows';
import {
  OutcomeUnresolvedError,
  type BookingStore,
  type BookingTx,
  type DeliveryAction,
  type DeliveryRecipient,
  type DeliveryRow,
  type LedgerClaim,
  type NewBookingRow,
  type OccupancyQuery,
  type OwnedUpdate,
} from './store';

type Mutex = { queue: Promise<void> };

export class MemoryBookingStore implements BookingStore {
  private readonly rows = new Map<string, BookingRow>();
  private readonly byToken = new Map<string, string>();
  private readonly byIdempotencyKey = new Map<string, string>();
  /** `(ownerId, key, fingerprint) → reason` — the C6.4 fence (REV8-01). */
  private readonly rejectedKeys = new Map<string, RejectionReason>();
  private readonly deliveries = new Map<string, DeliveryRow>();
  private readonly mutexes = new Map<string, Mutex>();
  /** Set by tests to make lock reacquisition time out (C6.5). */
  private lockUnavailable = false;

  reset(): void {
    this.rows.clear();
    this.byToken.clear();
    this.byIdempotencyKey.clear();
    this.rejectedKeys.clear();
    this.deliveries.clear();
    this.mutexes.clear();
    this.lockUnavailable = false;
  }

  setLockUnavailable(value: boolean): void {
    this.lockUnavailable = value;
  }

  async withHostLock<T>(hostId: string, fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    return this.locked(hostId, fn);
  }

  async withFinishedTransaction<T>(
    hostId: string,
    fn: (tx: BookingTx) => Promise<T>,
  ): Promise<T> {
    if (this.lockUnavailable) {
      // The outcome stays unknown: no compensation, no clearing (C6.5).
      throw new OutcomeUnresolvedError(null, 'host lock could not be reacquired');
    }
    // Awaiting the mutex is the memory-mode equivalent of reacquiring the
    // advisory lock: it establishes that the original transaction finished.
    return this.locked(hostId, fn);
  }

  private async locked<T>(hostId: string, fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    const mutex = this.mutexes.get(hostId) ?? { queue: Promise.resolve() };
    this.mutexes.set(hostId, mutex);
    const previous = mutex.queue;
    let release!: () => void;
    mutex.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous.catch(() => undefined);
    // Staged writes, applied together, so a throw inside `fn` rolls back.
    const staged = new MemoryTx(this);
    try {
      const value = await fn(staged);
      staged.commit();
      return value;
    } finally {
      release();
    }
  }

  // ---- reads --------------------------------------------------------------

  async getById(id: string): Promise<BookingRow | null> {
    const found = this.rows.get(id);
    return found ? cloneRow(found) : null;
  }

  async getByToken(token: string): Promise<BookingRow | null> {
    const id = this.byToken.get(token);
    return id === undefined ? null : this.getById(id);
  }

  /**
   * Every row, for the suite-wide invariant sweeps (CF-1..CF-3, AC-11/AC-23).
   * The pg side reads the fake's table directly; this is its counterpart.
   */
  allRows(): BookingRow[] {
    return [...this.rows.values()].map(cloneRow);
  }

  async occupancy(query: OccupancyQuery): Promise<Interval[]> {
    return this.occupancySync(query);
  }

  occupancySync(query: OccupancyQuery): Interval[] {
    const busy: Interval[] = [];
    for (const row of this.rows.values()) {
      if (row.hostId !== query.hostId || row.id === query.excludeBookingId) {
        continue;
      }
      // (a) every confirmed row of the host, including one whose reschedule
      // has not completed — the OLD interval is retained until T2 (C6.1).
      if (row.status === 'confirmed') {
        const interval = { start: row.start, end: row.end };
        if (overlaps(interval, query.window)) {
          busy.push(interval);
        }
      }
      // (b) every durable destination reservation written by reschedule T1.
      if (row.reservedStart !== null && row.reservedEnd !== null) {
        const reserved = { start: row.reservedStart, end: row.reservedEnd };
        if (overlaps(reserved, query.window)) {
          busy.push(reserved);
        }
      }
    }
    return busy;
  }

  async findByGoogleEventId(eventId: string): Promise<BookingRow | null> {
    for (const row of this.rows.values()) {
      if (
        row.googleEventId === eventId ||
        row.unresolvedInserts.some((entry) => entry.eventId === eventId)
      ) {
        return cloneRow(row);
      }
    }
    return null;
  }

  async findByBookingIdForReap(bookingId: string): Promise<BookingRow | null> {
    return this.getById(bookingId);
  }

  async retireAttempt(bookingId: string, attemptId: string): Promise<void> {
    const row = this.rows.get(bookingId);
    if (!row) {
      return;
    }
    // Idempotent by attemptId; never touches another attempt's entry.
    row.unresolvedInserts = row.unresolvedInserts.filter(
      (entry) => entry.attemptId !== attemptId,
    );
  }

  async stampReapBatch(
    bookingId: string,
    eventIds: string[],
    inspectedAt: string,
  ): Promise<number[]> {
    const row = this.rows.get(bookingId);
    if (!row || eventIds.length === 0) {
      return [];
    }
    const stamped: number[] = [];
    for (const eventId of eventIds) {
      row.reapCursor += 1;
      const seq = row.reapCursor;
      stamped.push(seq);
      for (const entry of row.unresolvedInserts) {
        if (entry.eventId === eventId) {
          entry.inspectSeq = seq;
          entry.inspectedAt = inspectedAt;
        }
      }
    }
    return stamped;
  }

  // ---- C5 ledger ----------------------------------------------------------

  async claimDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    nowMs: number;
  }): Promise<LedgerClaim> {
    const key = deliveryKey(input.bookingId, input.revision, input.action, input.recipient);
    const existing = this.deliveries.get(key);
    const nowIso = new Date(input.nowMs).toISOString();
    if (existing === undefined) {
      const row: DeliveryRow = {
        bookingId: input.bookingId,
        revision: input.revision,
        action: input.action,
        recipient: input.recipient,
        state: 'claimed',
        claimedAt: nowIso,
        attempts: 1,
      };
      this.deliveries.set(key, row);
      return { gen: 1 };
    }
    // The C5 predicate, exactly: `failed` has NO age condition; only a
    // `claimed` row carries the 2-minute stale window (REV7-04).
    const reclaimable =
      existing.state === 'failed' ||
      (existing.state === 'claimed' &&
        Date.parse(existing.claimedAt) < input.nowMs - CLAIM_STALE_MS);
    if (!reclaimable) {
      return null;
    }
    existing.state = 'claimed';
    existing.claimedAt = nowIso;
    existing.attempts += 1;
    return { gen: existing.attempts };
  }

  async finalizeDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    gen: number;
    state: 'sent' | 'failed';
  }): Promise<boolean> {
    const key = deliveryKey(input.bookingId, input.revision, input.action, input.recipient);
    const existing = this.deliveries.get(key);
    // Generation-conditioned: a late finaliser whose claim was taken over
    // updates zero rows (REV2-06).
    if (!existing || existing.state !== 'claimed' || existing.attempts !== input.gen) {
      return false;
    }
    existing.state = input.state;
    return true;
  }

  async deliveryRows(
    bookingId: string,
    revision: number,
    action: DeliveryAction,
  ): Promise<DeliveryRow[]> {
    return [...this.deliveries.values()]
      .filter(
        (row) =>
          row.bookingId === bookingId && row.revision === revision && row.action === action,
      )
      .map((row) => ({ ...row }));
  }

  // ---- internals used by MemoryTx ----------------------------------------

  /** @internal */ rawRows(): Map<string, BookingRow> {
    return this.rows;
  }

  /** @internal */ indexes(): {
    byToken: Map<string, string>;
    byIdempotencyKey: Map<string, string>;
    rejectedKeys: Map<string, RejectionReason>;
  } {
    return {
      byToken: this.byToken,
      byIdempotencyKey: this.byIdempotencyKey,
      rejectedKeys: this.rejectedKeys,
    };
  }
}

class MemoryTx implements BookingTx {
  private readonly writes: (() => void)[] = [];

  constructor(private readonly store: MemoryBookingStore) {}

  commit(): void {
    for (const write of this.writes) {
      write();
    }
    this.writes.length = 0;
  }

  /**
   * The memory store has no aborted-transaction state, so the savepoint is the
   * deferred-write list itself: a failed attempt discards only the writes it
   * queued, and the transaction stays usable (REVIEW-01).
   */
  async attempt<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    const mark = this.writes.length;
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      this.writes.length = mark;
      return { ok: false, error };
    }
  }

  async lookupKey(ownerId: string, idempotencyKey: string): Promise<BookingRow | null> {
    const id = this.store.indexes().byIdempotencyKey.get(keyOf(ownerId, idempotencyKey));
    if (id === undefined) {
      return null;
    }
    const row = this.store.rawRows().get(id);
    return row ? cloneRow(row) : null;
  }

  async lookupRejection(
    ownerId: string,
    idempotencyKey: string,
    createFingerprint: string,
  ): Promise<RejectionReason | null> {
    return (
      this.store
        .indexes()
        .rejectedKeys.get(fenceKey(ownerId, idempotencyKey, createFingerprint)) ?? null
    );
  }

  async insertRejection(input: {
    ownerId: string;
    idempotencyKey: string;
    createFingerprint: string;
    reason: RejectionReason;
  }): Promise<void> {
    const key = fenceKey(input.ownerId, input.idempotencyKey, input.createFingerprint);
    this.writes.push(() => {
      this.store.indexes().rejectedKeys.set(key, input.reason);
    });
  }

  async insertBooking(input: NewBookingRow): Promise<BookingRow> {
    const row: BookingRow = {
      id: input.id,
      token: input.token,
      idempotencyKey: input.idempotencyKey,
      createFingerprint: input.createFingerprint,
      ownerId: input.ownerId,
      eventTypeId: input.eventTypeId,
      hostId: input.hostId,
      start: input.start,
      end: input.end,
      status: 'confirmed',
      revision: 1,
      // CF-1: `pending` and NULL are written together, exactly once.
      latestAction: null,
      googleEventId: input.googleEventId,
      googleEventEtag: null,
      calendarState: 'pending',
      rescheduledFrom: null,
      reservedStart: null,
      reservedEnd: null,
      pendingOp: cloneOp(input.pendingOp),
      unfinishedCreate: null,
      unresolvedInserts: [],
      reapCursor: 0,
      inviteeName: input.inviteeName,
      inviteeEmail: input.inviteeEmail,
      notes: input.notes,
      metadata: { ...input.metadata },
      createdAt: input.createdAt,
    };
    this.writes.push(() => {
      this.store.rawRows().set(row.id, row);
      this.store.indexes().byToken.set(row.token, row.id);
      this.store
        .indexes()
        .byIdempotencyKey.set(keyOf(row.ownerId, row.idempotencyKey), row.id);
    });
    return cloneRow(row);
  }

  async selectForUpdate(id: string): Promise<BookingRow | null> {
    const row = this.store.rawRows().get(id);
    return row ? cloneRow(row) : null;
  }

  async occupancy(query: OccupancyQuery): Promise<Interval[]> {
    return this.store.occupancySync(query);
  }

  async update(update: OwnedUpdate): Promise<boolean> {
    const row = this.store.rawRows().get(update.id);
    if (!row) {
      return false;
    }
    if (row.revision !== update.expectedRevision) {
      return false;
    }
    if (update.requireConfirmed !== false && row.status !== 'confirmed') {
      return false;
    }
    if (update.opId !== undefined) {
      // Ownership: opId AND gen, or the worker is superseded (C6.3).
      if (
        row.pendingOp === null ||
        row.pendingOp.opId !== update.opId ||
        row.pendingOp.gen !== update.gen
      ) {
        return false;
      }
    }
    const patch = update.patch;
    this.writes.push(() => {
      const target = this.store.rawRows().get(update.id);
      if (!target) {
        return;
      }
      if (patch.start !== undefined) target.start = patch.start;
      if (patch.end !== undefined) target.end = patch.end;
      if (patch.status !== undefined) target.status = patch.status;
      if (patch.latestAction !== undefined) target.latestAction = patch.latestAction;
      if (patch.calendarState !== undefined) target.calendarState = patch.calendarState;
      if (patch.googleEventId !== undefined) target.googleEventId = patch.googleEventId;
      if (patch.googleEventEtag !== undefined) target.googleEventEtag = patch.googleEventEtag;
      if (patch.rescheduledFrom !== undefined) target.rescheduledFrom = patch.rescheduledFrom;
      if (patch.reservedStart !== undefined) target.reservedStart = patch.reservedStart;
      if (patch.reservedEnd !== undefined) target.reservedEnd = patch.reservedEnd;
      if (patch.pendingOp !== undefined) {
        target.pendingOp = patch.pendingOp === null ? null : cloneOp(patch.pendingOp);
      }
      if (patch.unfinishedCreate !== undefined) {
        target.unfinishedCreate =
          patch.unfinishedCreate === null
            ? null
            : {
                ...patch.unfinishedCreate,
                attempts: patch.unfinishedCreate.attempts.map((attempt) => ({ ...attempt })),
              };
      }
      if (patch.unresolvedInserts !== undefined) {
        target.unresolvedInserts = patch.unresolvedInserts.map((entry) => ({ ...entry }));
      }
      if (patch.bumpRevision === true) {
        target.revision += 1;
      }
    });
    return true;
  }

  async takeOver(id: string, opId: string, gen: number, startedAt: string): Promise<boolean> {
    const row = this.store.rawRows().get(id);
    if (!row || row.pendingOp === null) {
      return false;
    }
    if (row.pendingOp.opId !== opId || row.pendingOp.gen !== gen) {
      // Someone else took over first (C6.3).
      return false;
    }
    this.writes.push(() => {
      const target = this.store.rawRows().get(id);
      if (target?.pendingOp && target.pendingOp.opId === opId) {
        target.pendingOp.gen = gen + 1;
        target.pendingOp.startedAt = startedAt;
      }
    });
    return true;
  }

  async appendAttempt(
    id: string,
    opId: string,
    gen: number,
    attempt: Attempt,
  ): Promise<boolean> {
    const row = this.store.rawRows().get(id);
    if (
      !row ||
      row.pendingOp === null ||
      row.pendingOp.opId !== opId ||
      row.pendingOp.gen !== gen
    ) {
      return false;
    }
    this.writes.push(() => {
      const target = this.store.rawRows().get(id);
      if (target?.pendingOp && target.pendingOp.opId === opId) {
        target.pendingOp.attempts = [...target.pendingOp.attempts, { ...attempt }];
      }
    });
    return true;
  }

  async resolveAttempt(
    id: string,
    opId: string,
    gen: number,
    attemptId: string,
    outcome: 'applied' | 'rejected',
    resolvedAt: string,
  ): Promise<boolean> {
    const row = this.store.rawRows().get(id);
    if (!row || row.pendingOp === null || row.pendingOp.opId !== opId) {
      return false;
    }
    this.writes.push(() => {
      const target = this.store.rawRows().get(id);
      const attempt = target?.pendingOp?.attempts.find(
        (candidate) => candidate.attemptId === attemptId,
      );
      // A later attempt never resolves an earlier one; only its own response
      // resolves an attempt (C6.3b).
      if (attempt && attempt.outcome === 'unresolved') {
        attempt.outcome = outcome;
        attempt.resolvedAt = resolvedAt;
      }
    });
    return true;
  }

  async stampReapBatch(
    id: string,
    eventIds: string[],
    inspectedAt: string,
  ): Promise<number[]> {
    return this.store.stampReapBatch(id, eventIds, inspectedAt);
  }

  /**
   * C5 — the claim, issued inside this locked transaction. The memory store's
   * per-host mutex is the serialization boundary, so delegating to the store's
   * own claim here is atomic with the `selectForUpdate` that validated the pair.
   */
  async claimDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    nowMs: number;
  }): Promise<LedgerClaim> {
    return this.store.claimDelivery(input);
  }

  async retireAttempt(id: string, attemptId: string): Promise<void> {
    await this.store.retireAttempt(id, attemptId);
  }
}

export function orderedReapBatch(row: BookingRow, eligible: string[]): string[] {
  return orderReapCandidates(row, eligible);
}

function keyOf(ownerId: string, idempotencyKey: string): string {
  return `${ownerId}\u0000${idempotencyKey}`;
}

function fenceKey(ownerId: string, key: string, fingerprint: string): string {
  return `${ownerId}\u0000${key}\u0000${fingerprint}`;
}

function deliveryKey(
  bookingId: string,
  revision: number,
  action: DeliveryAction,
  recipient: DeliveryRecipient,
): string {
  return `${bookingId}\u0000${revision}\u0000${action}\u0000${recipient}`;
}
