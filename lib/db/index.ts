// Database seam (C8). Everything durable goes through `Queryable`, so the
// whole pg path is provable offline against the recording fake in
// `tests/support/pg-fake.ts` (AC-6): no driver, no `DATABASE_URL`, no network.
//
// `Database.connect()` hands out an identifiable connection because C6.5's
// unknown-commit reconciliation must reacquire the host advisory lock on a
// **fresh** connection — the fake asserts it really was a different one.

import { resolveEnv } from '../env';
import { createPgDatabase } from './driver';

export type QueryOptions = {
  /** Per-query server-side bound (C13's health readiness query). */
  statementTimeoutMs?: number;
};

export type QueryResult<R = Record<string, unknown>> = {
  rows: R[];
  rowCount: number;
  /**
   * The command tag Postgres answered with. Only `COMMIT` reads it: a
   * transaction the server has aborted answers `COMMIT` with **`ROLLBACK`**
   * and no error at all, so ignoring the tag lets a caller act on writes that
   * were discarded (REVIEW-01).
   */
  command?: string;
};

export interface Queryable {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<R>>;
}

export interface Connection extends Queryable {
  readonly connectionId: string;
  release(): Promise<void>;
}

export interface Database extends Queryable {
  connect(): Promise<Connection>;
}

let injected: Database | null = null;
let initError: Error | null = null;

/** Test/runtime seam: pins the database the stores and health route use. */
export function setDatabase(db: Database | null): void {
  injected = db;
  initError = null;
}

/**
 * The database `DATABASE_URL` selects, initialized on first use.
 *
 * There is **no memory fallback**: once `DATABASE_URL` is set the store mode is
 * `pg`, and a deployment that cannot reach a driver or a connection string must
 * report itself unavailable (503) rather than quietly serve from a per-isolate
 * map that loses every booking.
 */
export function ensureDatabase(): Database {
  if (injected !== null) {
    return injected;
  }
  if (initError !== null) {
    throw initError;
  }
  const url = resolveEnv().databaseUrl;
  if (url === null) {
    initError = new DatabaseUnavailableError('DATABASE_URL is not set');
    throw initError;
  }
  try {
    injected = createPgDatabase(url);
    return injected;
  } catch (error) {
    // **Normalised**, not preserved: `errorResponse` maps exactly one database
    // error type, so a `DriverUnavailableError` passed through unchanged escapes
    // as an untyped 500 instead of the documented 503 `store_driver_unavailable`
    // (REV-07). The original message is kept as the detail.
    initError = new DatabaseUnavailableError(detailOf(error));
    throw initError;
  }
}

function detailOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

/** The recorded initialization failure, if one has happened. */
export function databaseInitError(): Error | null {
  return initError;
}

export function getDatabase(): Database {
  if (injected === null) {
    throw new DatabaseUnavailableError();
  }
  return injected;
}

export function hasDatabase(): boolean {
  return injected !== null;
}

export class DatabaseUnavailableError extends Error {
  readonly code = 'store_driver_unavailable';
  constructor(detail = 'no Postgres driver is wired') {
    super(
      `store_driver_unavailable: ${detail}. Install a driver and set ` +
        'DATABASE_URL (see README → Durable store).',
    );
    this.name = 'DatabaseUnavailableError';
  }
}

export class NotMigratedError extends Error {
  readonly code = 'store_not_migrated';
  constructor(found: number | null, expected: number) {
    super(`store_not_migrated: schema_migrations at ${found ?? 'none'}, expected ${expected}`);
    this.name = 'NotMigratedError';
  }
}

// ---- transactions --------------------------------------------------------

export type CommitOutcome = 'definite' | 'unknown';

/**
 * C6.5: an unknown commit outcome is never interpreted from a plain read.
 * SQLSTATE class `08`, a reset/timed-out socket, or no server response at all
 * leaves the transaction's fate unknown; anything else is a definite failure.
 */
export function classifyCommitError(error: unknown): CommitOutcome {
  const code = errorCode(error);
  if (code !== null) {
    if (code.startsWith('08')) {
      return 'unknown';
    }
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EPIPE') {
      return 'unknown';
    }
    return 'definite';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/ECONNRESET|ETIMEDOUT|EPIPE|no response|connection terminated/i.test(message)) {
    return 'unknown';
  }
  return 'definite';
}

/**
 * `COMMIT` answered `ROLLBACK`: the transaction was aborted by an earlier
 * failed statement and kept nothing. Definite, never unknown.
 */
export class TransactionAbortedError extends Error {
  readonly outcome: CommitOutcome = 'definite';
  constructor() {
    super('transaction aborted: COMMIT answered ROLLBACK');
    this.name = 'TransactionAbortedError';
  }
}

export class UnknownCommitError extends Error {
  readonly outcome: CommitOutcome = 'unknown';
  constructor(readonly cause: unknown) {
    super('commit outcome unknown');
    this.name = 'UnknownCommitError';
  }
}

function errorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return null;
}

export type TransactionResult<T> = { value: T } | { commitUnknown: true; cause: unknown };

/**
 * Runs `fn` inside one transaction on a dedicated connection. A failed
 * `COMMIT` is classified (above): a definite failure rethrows, an unknown one
 * is returned as `{ commitUnknown: true }` so the caller can enter C6.5
 * reconciliation instead of guessing.
 */
export async function withTransaction<T>(
  db: Database,
  fn: (tx: Queryable) => Promise<T>,
): Promise<TransactionResult<T>> {
  const connection = await db.connect();
  try {
    await connection.query('BEGIN');
    let value: T;
    try {
      value = await fn(connection);
    } catch (error) {
      await rollbackQuietly(connection);
      throw error;
    }
    try {
      const committed = await connection.query('COMMIT');
      if (committed.command === 'ROLLBACK') {
        // A statement inside this transaction failed and left it aborted, so
        // the server discarded every write and answered `COMMIT` with
        // `ROLLBACK` — success-shaped, but nothing was kept. This is a
        // **definite** failure: the caller must not act on anything it wrote
        // (REVIEW-01).
        throw new TransactionAbortedError();
      }
    } catch (error) {
      if (error instanceof TransactionAbortedError) {
        throw error;
      }
      if (classifyCommitError(error) === 'unknown') {
        return { commitUnknown: true, cause: error };
      }
      throw error;
    }
    return { value };
  } finally {
    await connection.release();
  }
}

/** Throwing flavour for call sites that have no unknown-outcome branch. */
export async function inTransaction<T>(
  db: Database,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  const result = await withTransaction(db, fn);
  if ('commitUnknown' in result) {
    throw new UnknownCommitError(result.cause);
  }
  return result.value;
}

async function rollbackQuietly(connection: Connection): Promise<void> {
  try {
    await connection.query('ROLLBACK');
  } catch {
    // The transaction is already gone; nothing to undo.
  }
}

// ---- per-host serialization boundary (C6) --------------------------------

export const HOST_LOCK_SQL = 'SELECT pg_advisory_xact_lock(hashtext($1))';

/** C6: transaction-scoped advisory lock — safe under PgBouncer pooling. */
export async function takeHostLock(tx: Queryable, hostId: string): Promise<void> {
  await tx.query(HOST_LOCK_SQL, [hostId]);
}

export const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '5s'";
