// The durable booking row (C6 / C8) and the pure predicates over it.
//
// Nothing here touches a store or Google: these are the definitions the whole
// lifecycle agrees on, so the memory and pg stores cannot drift.

export type BookingRowStatus = 'confirmed' | 'cancelled';
export type CalendarState = 'pending' | 'created' | 'failed' | 'deleted';
export type LatestAction = 'confirm' | 'reschedule' | 'cancel';
export type OpKind = 'create' | 'reschedule' | 'cancel' | 'calendar_repair';
export type AttemptKind = 'insert' | 'patch' | 'delete' | 'bump';
export type AttemptOutcome = 'unresolved' | 'applied' | 'rejected';
export type RejectionReason = 'slot_unavailable' | 'session_full';

/** C6.3b — one durable entry per Google mutation, written BEFORE the request. */
export type Attempt = {
  attemptId: string;
  kind: AttemptKind;
  eventId: string;
  gen: number;
  issuedAt: string;
  ifMatch?: string;
  /** Finalised **only** by the issuing worker from its own response. */
  outcome: AttemptOutcome;
  resolvedAt?: string;
};

export type PendingOp = {
  kind: OpKind;
  opId: string;
  /** Ownership generation (C6.3); a takeover writes `gen + 1`. */
  gen: number;
  startedAt: string;
  /** Intended id a create/repair may create. */
  eventId?: string;
  newStart?: string;
  newEnd?: string;
  oldEventId?: string;
  /** Intended id a reschedule may create when its patch 404s. */
  fallbackEventId?: string;
  etag?: string;
  attempts: Attempt[];
};

/** C6.3a — an insert attempt whose outcome this app never observed. */
export type UnresolvedInsert = {
  attemptId: string;
  eventId: string;
  opId: string;
  gen: number;
  issuedAt: string;
  /** Fair-traversal mark drawn from `reap_cursor`; the ONLY ordering key. */
  inspectSeq: number | null;
  /** Diagnostic only — orders nothing (REV13-01). */
  inspectedAt: string | null;
};

/** C6.4a — a create a non-create op inherited but did not complete. */
export type UnfinishedCreate = {
  opId: string;
  gen: number;
  eventId: string;
  startedAt: string;
  attempts: Attempt[];
};

export type BookingRow = {
  id: string;
  token: string;
  idempotencyKey: string;
  createFingerprint: string;
  ownerId: string;
  eventTypeId: string;
  hostId: string;
  start: string;
  end: string;
  status: BookingRowStatus;
  revision: number;
  /** NULL exactly while the creation is unfinalized (CF-1). */
  latestAction: LatestAction | null;
  googleEventId: string | null;
  googleEventEtag: string | null;
  calendarState: CalendarState;
  rescheduledFrom: string | null;
  reservedStart: string | null;
  reservedEnd: string | null;
  pendingOp: PendingOp | null;
  unfinishedCreate: UnfinishedCreate | null;
  unresolvedInserts: UnresolvedInsert[];
  reapCursor: number;
  inviteeName: string;
  inviteeEmail: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type Interval = { start: string; end: string };

/** C6.3 — an op is stale two minutes after its owner last touched it. */
export const OP_STALE_MS = 120_000;

/** C6.3a — per-request reap batch size. */
export const REAP_MAX_PER_REQUEST = 5;

/** C5 — delivery claim stale window. */
export const CLAIM_STALE_MS = 120_000;

export function isStaleOp(op: PendingOp, nowMs: number): boolean {
  return nowMs - Date.parse(op.startedAt) > OP_STALE_MS;
}

export function retryAfterSeconds(op: PendingOp, nowMs: number): number {
  const remaining = OP_STALE_MS - (nowMs - Date.parse(op.startedAt));
  return Math.max(1, Math.ceil(remaining / 1000));
}

// ---- live vs retired ids (C6.3a / REV5-02) -------------------------------

/**
 * An id is **live** iff `status='confirmed' AND id = google_event_id`; every
 * other id an entry names is **retired**, and retired is *absorbing* — no id
 * is ever promoted back to live.
 */
export function liveEventId(row: BookingRow): string | null {
  return row.status === 'confirmed' ? row.googleEventId : null;
}

export function isLiveId(row: BookingRow, eventId: string): boolean {
  return liveEventId(row) === eventId;
}

/** Intended ids of the currently open op — never reap-eligible. */
export function openOpIntendedIds(row: BookingRow): string[] {
  const op = row.pendingOp;
  if (op === null) {
    return [];
  }
  return [op.eventId, op.fallbackEventId, op.oldEventId].filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
}

/**
 * C6.3a eligible set: every id named by `unresolved_inserts` minus the live id.
 * Computed from ONE read of the row, never from an earlier snapshot.
 */
export function eligibleReapIds(row: BookingRow): string[] {
  const live = liveEventId(row);
  const seen = new Set<string>();
  const eligible: string[] = [];
  for (const entry of row.unresolvedInserts) {
    if (entry.eventId === live || seen.has(entry.eventId)) {
      continue;
    }
    seen.add(entry.eventId);
    eligible.push(entry.eventId);
  }
  return eligible;
}

/**
 * C6.3a fair order: smallest `inspectSeq` first (`null` first), ties by
 * `issuedAt`, then by `eventId` — a total order over the eligible set that
 * advances strictly however the clock behaves (REV13-01).
 */
export function orderReapCandidates(row: BookingRow, eligible: string[]): string[] {
  const markOf = (eventId: string): { seq: number | null; issuedAt: string } => {
    const entries = row.unresolvedInserts.filter((entry) => entry.eventId === eventId);
    let seq: number | null = null;
    let issuedAt = '';
    for (const entry of entries) {
      if (entry.inspectSeq === null) {
        seq = null;
        issuedAt = issuedAt === '' || entry.issuedAt < issuedAt ? entry.issuedAt : issuedAt;
        return { seq, issuedAt };
      }
      if (seq === null || entry.inspectSeq < seq) {
        seq = entry.inspectSeq;
      }
      if (issuedAt === '' || entry.issuedAt < issuedAt) {
        issuedAt = entry.issuedAt;
      }
    }
    return { seq, issuedAt };
  };

  return [...eligible].sort((a, b) => {
    const left = markOf(a);
    const right = markOf(b);
    if (left.seq === null && right.seq !== null) return -1;
    if (left.seq !== null && right.seq === null) return 1;
    if (left.seq !== null && right.seq !== null && left.seq !== right.seq) {
      return left.seq - right.seq;
    }
    if (left.issuedAt !== right.issuedAt) {
      return left.issuedAt < right.issuedAt ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function selectReapBatch(row: BookingRow, max = REAP_MAX_PER_REQUEST): string[] {
  return orderReapCandidates(row, eligibleReapIds(row)).slice(0, max);
}

// ---- attempts (C6.3b) ----------------------------------------------------

export function unresolvedInsertAttempts(op: PendingOp | null): Attempt[] {
  if (op === null) {
    return [];
  }
  return op.attempts.filter(
    (attempt) => attempt.kind === 'insert' && attempt.outcome === 'unresolved',
  );
}

/**
 * C6.3b clearing rule: a clearing update may null `pending_op` only when every
 * unresolved insert attempt — **including one naming the resulting
 * `google_event_id`** — has been appended to `unresolved_inserts`.
 */
export function retainedFrom(
  existing: UnresolvedInsert[],
  attempts: Attempt[],
): UnresolvedInsert[] {
  const byAttempt = new Map(existing.map((entry) => [entry.attemptId, entry]));
  for (const attempt of attempts) {
    if (attempt.kind !== 'insert' || attempt.outcome !== 'unresolved') {
      continue;
    }
    if (byAttempt.has(attempt.attemptId)) {
      continue;
    }
    byAttempt.set(attempt.attemptId, {
      attemptId: attempt.attemptId,
      eventId: attempt.eventId,
      opId: '',
      gen: attempt.gen,
      issuedAt: attempt.issuedAt,
      inspectSeq: null,
      inspectedAt: null,
    });
  }
  return [...byAttempt.values()];
}

// ---- invariants (C6.4a) --------------------------------------------------

/** CF-1: `calendar_state='pending' ⇔ latest_action IS NULL`. */
export function holdsCF1(row: BookingRow): boolean {
  return (row.calendarState === 'pending') === (row.latestAction === null);
}

/** CF-2: `pending_op IS NULL ⇒ latest_action IS NOT NULL`. */
export function holdsCF2(row: BookingRow): boolean {
  return row.pendingOp !== null || row.latestAction !== null;
}

/** CF-3: `unfinished_create IS NOT NULL ⇒ latest_action IS NULL`. */
export function holdsCF3(row: BookingRow): boolean {
  return row.unfinishedCreate === null || row.latestAction === null;
}

export function assertInvariants(row: BookingRow): void {
  if (!holdsCF1(row) || !holdsCF2(row) || !holdsCF3(row)) {
    throw new Error(
      `booking invariant violated for ${row.id}: ` +
        `calendar_state=${row.calendarState} latest_action=${row.latestAction} ` +
        `pending_op=${row.pendingOp === null ? 'null' : row.pendingOp.kind} ` +
        `unfinished_create=${row.unfinishedCreate === null ? 'null' : 'set'}`,
    );
  }
}

export function cloneRow(row: BookingRow): BookingRow {
  return {
    ...row,
    pendingOp: row.pendingOp === null ? null : cloneOp(row.pendingOp),
    unfinishedCreate:
      row.unfinishedCreate === null
        ? null
        : {
            ...row.unfinishedCreate,
            attempts: row.unfinishedCreate.attempts.map((attempt) => ({ ...attempt })),
          },
    unresolvedInserts: row.unresolvedInserts.map((entry) => ({ ...entry })),
    metadata: { ...row.metadata },
  };
}

export function cloneOp(op: PendingOp): PendingOp {
  return { ...op, attempts: op.attempts.map((attempt) => ({ ...attempt })) };
}

export function overlaps(a: Interval, b: Interval): boolean {
  return Date.parse(a.start) < Date.parse(b.end) && Date.parse(b.start) < Date.parse(a.end);
}
