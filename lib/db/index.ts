// Database seam (C8). Everything durable goes through `Queryable`, so the
// whole pg path is provable offline against the recording fake in
// `tests/support/pg-fake.ts` (AC-6): no driver, no `DATABASE_URL`, no network.
//
// `Database.connect()` hands out an identifiable connection because C6.5's
// unknown-commit reconciliation must reacquire the host advisory lock on a
// **fresh** connection — the fake asserts it really was a different one.

export type QueryOptions = {
  /** Per-query server-side bound (C13's health readiness query). */
  statementTimeoutMs?: number;
};

export type QueryResult<R = Record<string, unknown>> = {
  rows: R[];
  rowCount: number;
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

/** Test/runtime seam: pins the database the stores and health route use. */
export function setDatabase(db: Database | null): void {
  injected = db;
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
  constructor() {
    super(
      'store_driver_unavailable: no Postgres driver is wired. Install a driver ' +
        'and call setDatabase() during boot (see README → Durable store).',
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
      await connection.query('COMMIT');
    } catch (error) {
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
