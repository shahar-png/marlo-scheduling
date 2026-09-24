// Durable `BookingStore` over Postgres (C6, C8). Every statement is
// parameterized and asserted by the recording fake in the tests (AC-3), and
// the whole file is provable offline: it never imports a driver.

import {
  LOCK_TIMEOUT_SQL,
  NotMigratedError,
  UnknownCommitError,
  classifyCommitError,
  takeHostLock,
  withTransaction,
  type Database,
  type Queryable,
} from '../db/index';
import { LATEST_SCHEMA_VERSION } from '../db/schema-version';
import {
  CLAIM_STALE_MS,
  type Attempt,
  type BookingRow,
  type CalendarState,
  type Interval,
  type LatestAction,
  type PendingOp,
  type RejectionReason,
  type UnfinishedCreate,
  type UnresolvedInsert,
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

const COLUMNS = `id, token, idempotency_key, create_fingerprint, owner_id, event_type_id,
    host_id, "start", "end", status, revision, latest_action, google_event_id,
    google_event_etag, calendar_state, rescheduled_from, reserved_start, reserved_end,
    pending_op, unfinished_create, unresolved_inserts, reap_cursor, invitee_name,
    invitee_email, notes, metadata, created_at`;

export const SELECT_BY_ID = `SELECT ${COLUMNS} FROM bookings WHERE id = $1`;
export const SELECT_BY_TOKEN = `SELECT ${COLUMNS} FROM bookings WHERE token = $1`;
export const SELECT_BY_ID_FOR_UPDATE = `SELECT ${COLUMNS} FROM bookings WHERE id = $1 FOR UPDATE`;
export const SELECT_BY_KEY = `SELECT ${COLUMNS} FROM bookings WHERE owner_id = $1 AND idempotency_key = $2`;
export const SELECT_FENCE =
  'SELECT reason FROM create_rejections WHERE owner_id = $1 AND idempotency_key = $2 AND create_fingerprint = $3';
export const INSERT_FENCE =
  'INSERT INTO create_rejections (owner_id, idempotency_key, create_fingerprint, reason) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING';
export const OCCUPANCY_SQL = `SELECT "start", "end", reserved_start, reserved_end FROM bookings
   WHERE host_id = $1
     AND ($4::text IS NULL OR id <> $4)
     AND ((status = 'confirmed' AND "start" < $3 AND "end" > $2)
       OR (reserved_start IS NOT NULL AND reserved_start < $3 AND reserved_end > $2))`;

export class PgBookingStore implements BookingStore {
  private migrated = false;

  constructor(private readonly db: Database) {}

  /** C8: refuse to serve until the latest `sql/` version is applied. */
  async assertMigrated(): Promise<void> {
    if (this.migrated) {
      return;
    }
    let version: number | null = null;
    try {
      const result = await this.db.query<{ version: unknown }>(
        'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
      );
      version = result.rows.length === 0 ? null : Number(result.rows[0].version);
    } catch {
      throw new NotMigratedError(null, LATEST_SCHEMA_VERSION);
    }
    if (version === null || !Number.isFinite(version) || version < LATEST_SCHEMA_VERSION) {
      throw new NotMigratedError(version, LATEST_SCHEMA_VERSION);
    }
    this.migrated = true;
  }

  async withHostLock<T>(hostId: string, fn: (tx: BookingTx) => Promise<T>): Promise<T> {
    await this.assertMigrated();
    const result = await withTransaction(this.db, async (tx) => {
      await takeHostLock(tx, hostId);
      return fn(new PgTx(tx));
    });
    if ('commitUnknown' in result) {
      // Never interpreted here: the caller enters C6.5 reconciliation.
      throw new UnknownCommitError(result.cause);
    }
    return result.value;
  }

  async withFinishedTransaction<T>(
    hostId: string,
    fn: (tx: BookingTx) => Promise<T>,
  ): Promise<T> {
    await this.assertMigrated();
    // A FRESH connection: because the original transaction holds the advisory
    // lock until it commits or rolls back, a successful reacquisition
    // establishes that it has finished (C6.5).
    const connection = await this.db.connect();
    try {
      await connection.query('BEGIN');
      try {
        await connection.query(LOCK_TIMEOUT_SQL);
        await takeHostLock(connection, hostId);
      } catch (error) {
        await safeRollback(connection);
        // Lock timeout or connection error: the outcome stays unknown.
        throw new OutcomeUnresolvedError(null, `lock reacquisition failed: ${messageOf(error)}`);
      }
      let value: T;
      try {
        value = await fn(new PgTx(connection));
      } catch (error) {
        await safeRollback(connection);
        throw error;
      }
      try {
        await connection.query('COMMIT');
      } catch (error) {
        if (classifyCommitError(error) === 'unknown') {
          throw new OutcomeUnresolvedError(null, 'reconciliation commit outcome unknown');
        }
        throw error;
      }
      return value;
    } finally {
      await connection.release();
    }
  }

  async getById(id: string): Promise<BookingRow | null> {
    await this.assertMigrated();
    const result = await this.db.query(SELECT_BY_ID, [id]);
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  async getByToken(token: string): Promise<BookingRow | null> {
    await this.assertMigrated();
    const result = await this.db.query(SELECT_BY_TOKEN, [token]);
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  async occupancy(query: OccupancyQuery): Promise<Interval[]> {
    await this.assertMigrated();
    return occupancyOn(this.db, query);
  }

  async findByGoogleEventId(eventId: string): Promise<BookingRow | null> {
    await this.assertMigrated();
    const result = await this.db.query(
      `SELECT ${COLUMNS} FROM bookings
         WHERE google_event_id = $1
            OR unresolved_inserts @> jsonb_build_array(jsonb_build_object('eventId', $1::text))
         LIMIT 1`,
      [eventId],
    );
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  async findByBookingIdForReap(bookingId: string): Promise<BookingRow | null> {
    return this.getById(bookingId);
  }

  async retireAttempt(bookingId: string, attemptId: string): Promise<void> {
    await this.assertMigrated();
    await this.db.query(RETIRE_ATTEMPT_SQL, [bookingId, attemptId]);
  }

  async stampReapBatch(
    bookingId: string,
    eventIds: string[],
    inspectedAt: string,
  ): Promise<number[]> {
    await this.assertMigrated();
    if (eventIds.length === 0) {
      return [];
    }
    const result = await this.db.query<{ reap_cursor: unknown }>(STAMP_REAP_SQL, [
      bookingId,
      JSON.stringify(eventIds),
      inspectedAt,
    ]);
    const cursor = Number(result.rows[0]?.reap_cursor ?? 0);
    const base = cursor - eventIds.length;
    return eventIds.map((_, index) => base + index + 1);
  }

  // ---- C5 ledger ----------------------------------------------------------

  async claimDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    nowMs: number;
  }): Promise<LedgerClaim> {
    await this.assertMigrated();
    const result = await this.db.query<{ attempts: unknown }>(CLAIM_SQL, [
      input.bookingId,
      input.revision,
      input.action,
      input.recipient,
      new Date(input.nowMs).toISOString(),
      new Date(input.nowMs - CLAIM_STALE_MS).toISOString(),
    ]);
    if (result.rows.length === 0) {
      return null;
    }
    return { gen: Number(result.rows[0].attempts) };
  }

  async finalizeDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    gen: number;
    state: 'sent' | 'failed';
  }): Promise<boolean> {
    await this.assertMigrated();
    const result = await this.db.query(FINALIZE_SQL, [
      input.bookingId,
      input.revision,
      input.action,
      input.recipient,
      input.gen,
      input.state,
    ]);
    return result.rowCount > 0;
  }

  async deliveryRows(
    bookingId: string,
    revision: number,
    action: DeliveryAction,
  ): Promise<DeliveryRow[]> {
    await this.assertMigrated();
    const result = await this.db.query(
      `SELECT booking_id, revision, action, recipient, state, claimed_at, attempts
         FROM notification_deliveries
         WHERE booking_id = $1 AND revision = $2 AND action = $3`,
      [bookingId, revision, action],
    );
    return result.rows.map(mapDeliveryRow);
  }
}

export const CLAIM_SQL = `INSERT INTO notification_deliveries
    (booking_id, revision, action, recipient, state, claimed_at, attempts)
  VALUES ($1, $2, $3, $4, 'claimed', $5, 1)
  ON CONFLICT (booking_id, revision, action, recipient) DO UPDATE
    SET state = 'claimed', claimed_at = $5, attempts = notification_deliveries.attempts + 1
    WHERE notification_deliveries.state = 'failed'
       OR (notification_deliveries.state = 'claimed' AND notification_deliveries.claimed_at < $6)
  RETURNING attempts`;

export const FINALIZE_SQL = `UPDATE notification_deliveries SET state = $6
   WHERE booking_id = $1 AND revision = $2 AND action = $3 AND recipient = $4
     AND state = 'claimed' AND attempts = $5`;

export const RETIRE_ATTEMPT_SQL = `UPDATE bookings
   SET unresolved_inserts = (
     SELECT COALESCE(jsonb_agg(entry), '[]'::jsonb)
       FROM jsonb_array_elements(unresolved_inserts) AS entry
      WHERE entry->>'attemptId' <> $2
   )
   WHERE id = $1`;

export const STAMP_REAP_SQL = `UPDATE bookings
   SET reap_cursor = reap_cursor + jsonb_array_length($2::jsonb),
       unresolved_inserts = (
         SELECT COALESCE(jsonb_agg(
           CASE WHEN batch.ordinality IS NULL THEN entry
                ELSE jsonb_set(
                       jsonb_set(entry, '{inspectSeq}',
                         to_jsonb(bookings.reap_cursor + batch.ordinality)),
                       '{inspectedAt}', to_jsonb($3::text))
           END), '[]'::jsonb)
           FROM jsonb_array_elements(unresolved_inserts) AS entry
           LEFT JOIN LATERAL (
             SELECT ordinality FROM jsonb_array_elements_text($2::jsonb)
               WITH ORDINALITY AS ids(event_id, ordinality)
              WHERE ids.event_id = entry->>'eventId'
              LIMIT 1
           ) AS batch ON true
       )
   WHERE id = $1
   RETURNING reap_cursor`;

class PgTx implements BookingTx {
  constructor(private readonly tx: Queryable) {}

  private savepointSeq = 0;

  /**
   * `SAVEPOINT` → run → `RELEASE`, or `ROLLBACK TO SAVEPOINT` on failure, so a
   * recoverable error leaves the transaction usable instead of aborted
   * (REVIEW-01). The name is generated here and never interpolated from input.
   */
  async attempt<T>(
    fn: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    this.savepointSeq += 1;
    const name = `marlo_sp_${this.savepointSeq}`;
    await this.tx.query(`SAVEPOINT ${name}`);
    try {
      const value = await fn();
      await this.tx.query(`RELEASE SAVEPOINT ${name}`);
      return { ok: true, value };
    } catch (error) {
      await this.tx.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await this.tx.query(`RELEASE SAVEPOINT ${name}`);
      return { ok: false, error };
    }
  }

  async lookupKey(ownerId: string, idempotencyKey: string): Promise<BookingRow | null> {
    const result = await this.tx.query(SELECT_BY_KEY, [ownerId, idempotencyKey]);
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  async lookupRejection(
    ownerId: string,
    idempotencyKey: string,
    createFingerprint: string,
  ): Promise<RejectionReason | null> {
    const result = await this.tx.query<{ reason: unknown }>(SELECT_FENCE, [
      ownerId,
      idempotencyKey,
      createFingerprint,
    ]);
    if (result.rows.length === 0) {
      return null;
    }
    const reason = String(result.rows[0].reason);
    return reason === 'session_full' ? 'session_full' : 'slot_unavailable';
  }

  async insertRejection(input: {
    ownerId: string;
    idempotencyKey: string;
    createFingerprint: string;
    reason: RejectionReason;
  }): Promise<void> {
    await this.tx.query(INSERT_FENCE, [
      input.ownerId,
      input.idempotencyKey,
      input.createFingerprint,
      input.reason,
    ]);
  }

  async insertBooking(input: NewBookingRow): Promise<BookingRow> {
    const result = await this.tx.query(
      `INSERT INTO bookings
         (id, token, idempotency_key, create_fingerprint, owner_id, event_type_id, host_id,
          "start", "end", status, revision, latest_action, google_event_id, calendar_state,
          pending_op, unresolved_inserts, reap_cursor, invitee_name, invitee_email, notes,
          metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', 1, NULL, $10, 'pending',
               $11, '[]'::jsonb, 0, $12, $13, $14, $15, $16)
       RETURNING ${COLUMNS}`,
      [
        input.id,
        input.token,
        input.idempotencyKey,
        input.createFingerprint,
        input.ownerId,
        input.eventTypeId,
        input.hostId,
        input.start,
        input.end,
        input.googleEventId,
        JSON.stringify(input.pendingOp),
        input.inviteeName,
        input.inviteeEmail,
        input.notes,
        JSON.stringify(input.metadata),
        input.createdAt,
      ],
    );
    return mapRow(result.rows[0]);
  }

  async selectForUpdate(id: string): Promise<BookingRow | null> {
    const result = await this.tx.query(SELECT_BY_ID_FOR_UPDATE, [id]);
    return result.rows.length === 0 ? null : mapRow(result.rows[0]);
  }

  async occupancy(query: OccupancyQuery): Promise<Interval[]> {
    return occupancyOn(this.tx, query);
  }

  async update(update: OwnedUpdate): Promise<boolean> {
    const sets: string[] = [];
    const params: unknown[] = [update.id, update.expectedRevision];
    const patch = update.patch;

    const push = (column: string, value: unknown): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (patch.start !== undefined) push('"start"', patch.start);
    if (patch.end !== undefined) push('"end"', patch.end);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.latestAction !== undefined) push('latest_action', patch.latestAction);
    if (patch.calendarState !== undefined) push('calendar_state', patch.calendarState);
    if (patch.googleEventId !== undefined) push('google_event_id', patch.googleEventId);
    if (patch.googleEventEtag !== undefined) push('google_event_etag', patch.googleEventEtag);
    if (patch.rescheduledFrom !== undefined) push('rescheduled_from', patch.rescheduledFrom);
    if (patch.reservedStart !== undefined) push('reserved_start', patch.reservedStart);
    if (patch.reservedEnd !== undefined) push('reserved_end', patch.reservedEnd);
    if (patch.pendingOp !== undefined) {
      push('pending_op', patch.pendingOp === null ? null : JSON.stringify(patch.pendingOp));
    }
    if (patch.unfinishedCreate !== undefined) {
      push(
        'unfinished_create',
        patch.unfinishedCreate === null ? null : JSON.stringify(patch.unfinishedCreate),
      );
    }
    if (patch.unresolvedInserts !== undefined) {
      push('unresolved_inserts', JSON.stringify(patch.unresolvedInserts));
    }
    if (patch.bumpRevision === true) {
      sets.push('revision = revision + 1');
    }
    if (sets.length === 0) {
      return true;
    }

    let where = 'id = $1 AND revision = $2';
    if (update.requireConfirmed !== false) {
      where += " AND status = 'confirmed'";
    }
    if (update.opId !== undefined) {
      params.push(update.opId);
      where += ` AND pending_op->>'opId' = $${params.length}`;
      params.push(update.gen);
      where += ` AND (pending_op->>'gen')::int = $${params.length}`;
    }

    const result = await this.tx.query(
      `UPDATE bookings SET ${sets.join(', ')} WHERE ${where}`,
      params,
    );
    return result.rowCount > 0;
  }

  async takeOver(id: string, opId: string, gen: number, startedAt: string): Promise<boolean> {
    const result = await this.tx.query(
      `UPDATE bookings
         SET pending_op = pending_op || jsonb_build_object('gen', $3::int + 1, 'startedAt', $4::text)
         WHERE id = $1 AND pending_op->>'opId' = $2 AND (pending_op->>'gen')::int = $3`,
      [id, opId, gen, startedAt],
    );
    return result.rowCount > 0;
  }

  async appendAttempt(
    id: string,
    opId: string,
    gen: number,
    attempt: Attempt,
  ): Promise<boolean> {
    const result = await this.tx.query(
      `UPDATE bookings
         SET pending_op = jsonb_set(pending_op, '{attempts}',
               COALESCE(pending_op->'attempts', '[]'::jsonb) || $4::jsonb)
         WHERE id = $1 AND pending_op->>'opId' = $2 AND (pending_op->>'gen')::int = $3`,
      [id, opId, gen, JSON.stringify([attempt])],
    );
    return result.rowCount > 0;
  }

  async resolveAttempt(
    id: string,
    opId: string,
    gen: number,
    attemptId: string,
    outcome: 'applied' | 'rejected',
    resolvedAt: string,
  ): Promise<boolean> {
    const result = await this.tx.query(
      // Parameters are contiguous ($1..$4): Postgres rejects a gap because it
      // cannot infer the skipped placeholder's type. `gen` is deliberately NOT
      // in the predicate — an attempt is finalised by the worker that ISSUED it
      // (C6.3b), which may since have been superseded under a higher generation,
      // and `attemptId` already identifies exactly one entry.
      `UPDATE bookings
         SET pending_op = jsonb_set(pending_op, '{attempts}', (
           SELECT COALESCE(jsonb_agg(
             CASE WHEN entry->>'attemptId' = $3 AND entry->>'outcome' = 'unresolved'
                  THEN entry || jsonb_build_object('outcome', $4::text, 'resolvedAt', $5::text)
                  ELSE entry END), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(pending_op->'attempts', '[]'::jsonb)) AS entry
         ))
         WHERE id = $1 AND pending_op->>'opId' = $2`,
      [id, opId, attemptId, outcome, resolvedAt],
    );
    return result.rowCount > 0;
  }

  async stampReapBatch(
    id: string,
    eventIds: string[],
    inspectedAt: string,
  ): Promise<number[]> {
    if (eventIds.length === 0) {
      return [];
    }
    const result = await this.tx.query<{ reap_cursor: unknown }>(STAMP_REAP_SQL, [
      id,
      JSON.stringify(eventIds),
      inspectedAt,
    ]);
    const cursor = Number(result.rows[0]?.reap_cursor ?? 0);
    const base = cursor - eventIds.length;
    return eventIds.map((_, index) => base + index + 1);
  }

  async retireAttempt(id: string, attemptId: string): Promise<void> {
    await this.tx.query(RETIRE_ATTEMPT_SQL, [id, attemptId]);
  }

  /** The same C5 claim SQL, on this transaction's connection (C5 / REV2-06). */
  async claimDelivery(input: {
    bookingId: string;
    revision: number;
    action: DeliveryAction;
    recipient: DeliveryRecipient;
    nowMs: number;
  }): Promise<LedgerClaim> {
    const result = await this.tx.query<{ attempts: unknown }>(CLAIM_SQL, [
      input.bookingId,
      input.revision,
      input.action,
      input.recipient,
      new Date(input.nowMs).toISOString(),
      new Date(input.nowMs - CLAIM_STALE_MS).toISOString(),
    ]);
    if (result.rows.length === 0) {
      return null;
    }
    return { gen: Number(result.rows[0].attempts) };
  }
}

async function occupancyOn(db: Queryable, query: OccupancyQuery): Promise<Interval[]> {
  const result = await db.query<{
    start: unknown;
    end: unknown;
    reserved_start: unknown;
    reserved_end: unknown;
  }>(OCCUPANCY_SQL, [
    query.hostId,
    query.window.start,
    query.window.end,
    query.excludeBookingId ?? null,
  ]);
  const busy: Interval[] = [];
  for (const row of result.rows) {
    const start = isoOrNull(row.start);
    const end = isoOrNull(row.end);
    if (start !== null && end !== null) {
      busy.push({ start, end });
    }
    const reservedStart = isoOrNull(row.reserved_start);
    const reservedEnd = isoOrNull(row.reserved_end);
    if (reservedStart !== null && reservedEnd !== null) {
      busy.push({ start: reservedStart, end: reservedEnd });
    }
  }
  return busy;
}

async function safeRollback(connection: Queryable): Promise<void> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    // already gone
  }
}

export function mapRow(raw: Record<string, unknown>): BookingRow {
  return {
    id: String(raw.id),
    token: String(raw.token),
    idempotencyKey: String(raw.idempotency_key),
    createFingerprint: String(raw.create_fingerprint),
    ownerId: String(raw.owner_id),
    eventTypeId: String(raw.event_type_id),
    hostId: String(raw.host_id),
    start: isoOf(raw.start),
    end: isoOf(raw.end),
    status: raw.status === 'cancelled' ? 'cancelled' : 'confirmed',
    revision: Number(raw.revision),
    latestAction: latestActionOf(raw.latest_action),
    googleEventId: raw.google_event_id === null || raw.google_event_id === undefined
      ? null
      : String(raw.google_event_id),
    googleEventEtag:
      raw.google_event_etag === null || raw.google_event_etag === undefined
        ? null
        : String(raw.google_event_etag),
    calendarState: calendarStateOf(raw.calendar_state),
    rescheduledFrom: isoOrNull(raw.rescheduled_from),
    reservedStart: isoOrNull(raw.reserved_start),
    reservedEnd: isoOrNull(raw.reserved_end),
    pendingOp: jsonOf<PendingOp>(raw.pending_op),
    unfinishedCreate: jsonOf<UnfinishedCreate>(raw.unfinished_create),
    unresolvedInserts: jsonOf<UnresolvedInsert[]>(raw.unresolved_inserts) ?? [],
    reapCursor: Number(raw.reap_cursor ?? 0),
    inviteeName: String(raw.invitee_name),
    inviteeEmail: String(raw.invitee_email),
    notes: raw.notes === null || raw.notes === undefined ? null : String(raw.notes),
    metadata: jsonOf<Record<string, unknown>>(raw.metadata) ?? {},
    createdAt: isoOf(raw.created_at),
  };
}

function mapDeliveryRow(raw: Record<string, unknown>): DeliveryRow {
  return {
    bookingId: String(raw.booking_id),
    revision: Number(raw.revision),
    action: latestActionOf(raw.action) ?? 'confirm',
    recipient: raw.recipient === 'owner' ? 'owner' : 'invitee',
    state:
      raw.state === 'sent' ? 'sent' : raw.state === 'failed' ? 'failed' : 'claimed',
    claimedAt: isoOf(raw.claimed_at),
    attempts: Number(raw.attempts),
  };
}

function latestActionOf(value: unknown): LatestAction | null {
  if (value === 'confirm' || value === 'reschedule' || value === 'cancel') {
    return value;
  }
  return null;
}

function calendarStateOf(value: unknown): CalendarState {
  if (value === 'created' || value === 'failed' || value === 'deleted') {
    return value;
  }
  return 'pending';
}

function jsonOf<T>(value: unknown): T | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value as T;
}

function isoOf(value: unknown): string {
  const iso = isoOrNull(value);
  return iso === null ? '' : iso;
}

function isoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
