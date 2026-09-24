// The recording `Database` fake every pg-mode proof runs against (AC-6: no
// driver, no `DATABASE_URL`, no network).
//
// It is deliberately *statement-shaped* rather than a SQL engine: it matches
// the exact parameterized statements `PgBookingStore`, `PgOwnerStore`,
// `pgCatalogSource`, and `lib/db/health` issue, so a test can assert what SQL
// ran and in which order (AC-3, AC-15, AC-24) and a statement nobody planned
// for fails loudly instead of silently returning zero rows.
//
// Three behaviours exist only to make C6 provable offline:
//
//   * an explicit **lock queue** for `pg_advisory_xact_lock`, so two workers
//     can be interleaved deterministically and `SET LOCAL lock_timeout` can
//     actually time out (C6.5);
//   * configurable **`COMMIT` outcomes**, including the delayed completion of
//     C6.5 — a commit whose response is lost while the server-side transaction
//     stays open, holding the lock, and resolves later;
//   * **per-connection identity**, because C6.5's reconciler must reacquire the
//     lock on a *fresh* connection and the test has to prove it did.

import {
  LOCK_TIMEOUT_SQL,
  type Connection,
  type Database,
  type QueryOptions,
  type QueryResult,
} from '../../lib/db/index';
import { LATEST_SCHEMA_VERSION } from '../../lib/db/schema-version';
import {
  CLAIM_SQL,
  FINALIZE_SQL,
  INSERT_FENCE,
  OCCUPANCY_SQL,
  RETIRE_ATTEMPT_SQL,
  SELECT_BY_ID,
  SELECT_BY_ID_FOR_UPDATE,
  SELECT_BY_KEY,
  SELECT_BY_TOKEN,
  SELECT_FENCE,
  STAMP_REAP_SQL,
} from '../../lib/booking/pg-store';
import {
  SELECT_OWNER_BY_ID_SQL,
  SELECT_OWNER_BY_SLUG_SQL,
  UPSERT_EVENT_TYPE_SQL,
  UPSERT_OWNER_SQL,
  UPSERT_SCHEDULE_SQL,
} from '../../lib/owners-pg';
import {
  SELECT_EVENT_TYPE_BY_ID_SQL,
  SELECT_EVENT_TYPE_SQL,
  SELECT_SCHEDULE_SQL,
} from '../../lib/catalog';

export type Row = Record<string, unknown>;

export type Statement = {
  sql: string;
  params: readonly unknown[];
  connectionId: string;
};

/**
 * How the next `COMMIT` behaves. `unknown-*` throws `ECONNRESET` at the caller
 * (so it enters C6.5) while deciding the server-side fate itself; the delayed
 * form additionally keeps the transaction — and its advisory lock — open.
 */
export type CommitOutcome =
  | 'ok'
  | 'definite'
  | 'unknown-committed'
  | 'unknown-rolled-back'
  | { unknown: true; resolveAfterMs: number; as: 'commit' | 'rollback' };

export type SchemaQueryBehaviour =
  | { kind: 'rows'; version: number }
  | { kind: 'empty' }
  | { kind: 'missing-table' }
  | { kind: 'error'; code: string }
  | { kind: 'stall' };

type Tables = {
  bookings: Map<string, Row>;
  rejections: Map<string, Row>;
  deliveries: Map<string, Row>;
  owners: Map<string, Row>;
  hostTokens: Map<string, Row>;
  eventTypes: Map<string, Row>;
  schedules: Map<string, Row>;
  migrations: number[];
};

function emptyTables(): Tables {
  return {
    bookings: new Map(),
    rejections: new Map(),
    deliveries: new Map(),
    owners: new Map(),
    hostTokens: new Map(),
    eventTypes: new Map(),
    schedules: new Map(),
    migrations: [],
  };
}

function cloneTables(tables: Tables): Tables {
  return {
    bookings: new Map([...tables.bookings].map(([k, v]) => [k, { ...v }])),
    rejections: new Map([...tables.rejections].map(([k, v]) => [k, { ...v }])),
    deliveries: new Map([...tables.deliveries].map(([k, v]) => [k, { ...v }])),
    owners: new Map([...tables.owners].map(([k, v]) => [k, { ...v }])),
    hostTokens: new Map([...tables.hostTokens].map(([k, v]) => [k, { ...v }])),
    eventTypes: new Map([...tables.eventTypes].map(([k, v]) => [k, { ...v }])),
    schedules: new Map([...tables.schedules].map(([k, v]) => [k, { ...v }])),
    migrations: [...tables.migrations],
  };
}

// ---- the advisory lock queue ---------------------------------------------

type Waiter = {
  connectionId: string;
  resolve: () => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout | null;
};

class LockQueue {
  private readonly holders = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter[]>();
  /** Observability for tests that assert a worker really blocked. */
  readonly waitLog: Array<{ hostId: string; connectionId: string }> = [];

  holderOf(hostId: string): string | null {
    return this.holders.get(hostId) ?? null;
  }

  waiting(hostId: string): number {
    return (this.waiters.get(hostId) ?? []).length;
  }

  acquire(hostId: string, connectionId: string, timeoutMs: number | null): Promise<void> {
    const holder = this.holders.get(hostId);
    if (holder === undefined) {
      this.holders.set(hostId, connectionId);
      return Promise.resolve();
    }
    if (holder === connectionId) {
      return Promise.resolve();
    }
    this.waitLog.push({ hostId, connectionId });
    return new Promise<void>((resolve, reject) => {
      const queue = this.waiters.get(hostId) ?? [];
      const waiter: Waiter = { connectionId, resolve, reject, timer: null };
      if (timeoutMs !== null) {
        waiter.timer = setTimeout(() => {
          const current = this.waiters.get(hostId) ?? [];
          const index = current.indexOf(waiter);
          if (index !== -1) {
            current.splice(index, 1);
          }
          reject(lockTimeoutError());
        }, timeoutMs);
      }
      queue.push(waiter);
      this.waiters.set(hostId, queue);
    });
  }

  release(hostId: string, connectionId: string): void {
    if (this.holders.get(hostId) !== connectionId) {
      return;
    }
    this.holders.delete(hostId);
    const queue = this.waiters.get(hostId) ?? [];
    const next = queue.shift();
    if (next === undefined) {
      return;
    }
    if (next.timer !== null) {
      clearTimeout(next.timer);
    }
    this.holders.set(hostId, next.connectionId);
    next.resolve();
  }

  releaseAll(connectionId: string): void {
    for (const [hostId, holder] of [...this.holders]) {
      if (holder === connectionId) {
        this.release(hostId, connectionId);
      }
    }
  }
}

function lockTimeoutError(): Error {
  const error = new Error('canceling statement due to lock timeout') as Error & {
    code?: string;
  };
  error.code = '55P03';
  return error;
}

function pgError(code: string, message: string): Error {
  const error = new Error(message) as Error & { code?: string };
  error.code = code;
  return error;
}

function connectionResetError(): Error {
  const error = new Error('Connection terminated unexpectedly') as Error & {
    code?: string;
  };
  error.code = 'ECONNRESET';
  return error;
}

function definiteCommitError(): Error {
  const error = new Error('could not serialize access') as Error & { code?: string };
  error.code = '40001';
  return error;
}

// ---- the database ---------------------------------------------------------

export type FakeDatabase = Database & {
  readonly statements: Statement[];
  readonly locks: LockQueue;
  /** SQL text of every statement, for order assertions. */
  sqlLog(): string[];
  /** Statements touching a table, by simple substring match. */
  statementsOn(table: string): Statement[];
  clearLog(): void;
  /**
   * Applies to the next `COMMIT` only; then reverts to `'ok'`.
   *
   * `matching` picks *which* commit: a create runs several transactions (L0,
   * T1, T2), so a test that means "T1" says so — `{ matching: 'INSERT INTO
   * bookings' }` — instead of silently hitting whichever commits first.
   */
  setNextCommitOutcome(outcome: CommitOutcome, options?: { matching?: string }): void;
  /**
   * The next statement whose SQL contains `matching` fails, and — inside a
   * transaction — leaves it **aborted**, exactly as Postgres does (REVIEW-01).
   */
  failNextStatement(matching: string, options?: { code?: string }): void;
  setSchemaQuery(behaviour: SchemaQueryBehaviour): void;
  connectionsOpened(): string[];
  tables(): Tables;
  seedMigration(version?: number): void;
  seedOwner(row: Row): void;
  seedHostToken(row: Row): void;
  seedEventType(row: Row): void;
  seedSchedule(row: Row): void;
  seedBooking(row: Row): void;
  booking(id: string): Row | undefined;
  deliveries(): Row[];
  rejections(): Row[];
};

export type FakeDatabaseOptions = {
  /** Defaults to migrated at `LATEST_SCHEMA_VERSION`. */
  migrated?: boolean;
};

export function createFakeDatabase(options: FakeDatabaseOptions = {}): FakeDatabase {
  let tables = emptyTables();
  if (options.migrated !== false) {
    tables.migrations.push(LATEST_SCHEMA_VERSION);
  }

  const statements: Statement[] = [];
  const locks = new LockQueue();
  const opened: string[] = [];
  let nextCommit: CommitOutcome = 'ok';
  let nextCommitMatching: string | null = null;
  let schemaQuery: SchemaQueryBehaviour | null = null;
  let connectionSeq = 0;
  let scriptedFailure: { matching: string; code: string } | null = null;

  function takeScriptedFailure(text: string): Error | null {
    if (scriptedFailure === null || !text.includes(scriptedFailure.matching)) {
      return null;
    }
    const { code } = scriptedFailure;
    scriptedFailure = null;
    return pgError(code, `pg-fake: scripted failure (${code})`);
  }

  type ConnState = {
    id: string;
    inTransaction: boolean;
    snapshot: Tables | null;
    lockTimeoutMs: number | null;
    heldHosts: string[];
    /** SQL issued since `BEGIN`, so a commit outcome can be targeted. */
    txStatements: string[];
    /**
     * Postgres aborts the whole transaction on any failed statement: every
     * later statement answers `25P02` and `COMMIT` answers **`ROLLBACK`**
     * without erroring. Modelled here so the offline proof can tell a claim
     * that committed from one that was discarded (REVIEW-01).
     */
    aborted: boolean;
    /** `SAVEPOINT name` → the tables as of that savepoint. */
    savepoints: { name: string; snapshot: Tables }[];
  };

  async function execute(state: ConnState, sql: string, params: readonly unknown[], queryOptions?: QueryOptions): Promise<QueryResult> {
    statements.push({ sql, params, connectionId: state.id });
    const text = sql.trim();
    // Real Postgres parses placeholders before it executes anything; a
    // statement-shaped fake that only reads the values it cares about would
    // otherwise hide a parameter gap or a stray argument (LIVE-REVIEW-02).
    assertPlaceholdersContiguous(text, params);
    if (state.inTransaction) {
      state.txStatements.push(text);
    }

    // ---- transaction control ---------------------------------------------
    if (text === 'BEGIN') {
      state.inTransaction = true;
      state.txStatements = [];
      state.snapshot = cloneTables(tables);
      state.aborted = false;
      state.savepoints = [];
      return empty();
    }
    if (text === 'ROLLBACK') {
      if (state.snapshot !== null) {
        tables = state.snapshot;
      }
      endTransaction(state);
      return empty();
    }
    if (text.startsWith('SAVEPOINT ')) {
      state.savepoints.push({
        name: text.slice('SAVEPOINT '.length).trim(),
        snapshot: cloneTables(tables),
      });
      return empty();
    }
    if (text.startsWith('ROLLBACK TO SAVEPOINT ')) {
      const name = text.slice('ROLLBACK TO SAVEPOINT '.length).trim();
      const index = state.savepoints.findIndex((entry) => entry.name === name);
      if (index === -1) {
        throw pgError('42P01', `savepoint "${name}" does not exist`);
      }
      tables = cloneTables(state.savepoints[index].snapshot);
      state.savepoints.length = index + 1;
      // Rolling back to a savepoint is exactly what clears the aborted state.
      state.aborted = false;
      return empty();
    }
    if (text.startsWith('RELEASE SAVEPOINT ')) {
      const name = text.slice('RELEASE SAVEPOINT '.length).trim();
      const index = state.savepoints.findIndex((entry) => entry.name === name);
      if (index !== -1) {
        state.savepoints.length = index;
      }
      return empty();
    }
    if (text === 'COMMIT') {
      if (state.aborted) {
        // The tag Postgres really answers with — no error, nothing kept.
        if (state.snapshot !== null) {
          tables = state.snapshot;
        }
        endTransaction(state);
        return { rows: [], rowCount: 0, command: 'ROLLBACK' };
      }
      return commit(state);
    }
    if (state.aborted) {
      throw pgError(
        '25P02',
        'current transaction is aborted, commands ignored until end of transaction block',
      );
    }
    const failure = takeScriptedFailure(text);
    if (failure !== null) {
      if (state.inTransaction) {
        state.aborted = true;
      }
      throw failure;
    }
    if (text === LOCK_TIMEOUT_SQL) {
      state.lockTimeoutMs = 5_000;
      return empty();
    }
    if (text.startsWith('SELECT pg_advisory_xact_lock')) {
      const hostId = String(params[0]);
      await locks.acquire(hostId, state.id, state.lockTimeoutMs);
      state.heldHosts.push(hostId);
      // The snapshot is taken only once the lock is held, so a transaction that
      // waited sees the winner's committed writes rather than a stale copy.
      state.snapshot = cloneTables(tables);
      return empty();
    }

    // ---- health / migrations ---------------------------------------------
    if (text.startsWith('SELECT version FROM schema_migrations')) {
      return runSchemaQuery(queryOptions);
    }

    // ---- catalog (read-only; AC-24 asserts these are the ONLY ones) -------
    if (text === SELECT_OWNER_BY_SLUG_SQL) {
      return rowsOf([...tables.owners.values()].filter((row) => row.slug === params[0]));
    }
    if (text === SELECT_OWNER_BY_ID_SQL) {
      return rowsOf([...tables.owners.values()].filter((row) => row.id === params[0]));
    }
    if (text === UPSERT_OWNER_SQL) {
      const row = {
        id: params[0],
        slug: params[1],
        first_name: params[2],
        email: params[3],
        calendar_id: params[4],
      };
      tables.owners.set(String(params[0]), row);
      return rowsOf([row]);
    }
    if (text === UPSERT_SCHEDULE_SQL) {
      tables.schedules.set(String(params[0]), {
        id: params[0],
        owner_id: params[1],
        timezone: params[2],
        rules: params[3],
      });
      return empty();
    }
    if (text === UPSERT_EVENT_TYPE_SQL) {
      tables.eventTypes.set(String(params[0]), {
        id: params[0],
        owner_id: params[1],
        slug: params[2],
        // C6.9: materialization writes `one_on_one` and nothing else.
        kind: 'one_on_one',
        duration_min: params[3],
        capacity: null,
        notification_mode: params[4],
        schedule_id: params[5],
        name: params[6],
      });
      return empty();
    }
    if (text === SELECT_EVENT_TYPE_SQL) {
      return rowsOf(
        [...tables.eventTypes.values()].filter(
          (row) => row.owner_id === params[0] && row.slug === params[1],
        ),
      );
    }
    if (text === SELECT_EVENT_TYPE_BY_ID_SQL) {
      const row = tables.eventTypes.get(String(params[0]));
      return rowsOf(row === undefined ? [] : [row]);
    }
    if (text === SELECT_SCHEDULE_SQL) {
      return rowsOf([...tables.schedules.values()].filter((row) => row.id === params[0]));
    }
    if (text.startsWith('INSERT INTO host_tokens')) {
      tables.hostTokens.set(String(params[0]), {
        owner_id: params[0],
        refresh_token_enc: params[1],
        updated_at: params[2] ?? new Date().toISOString(),
      });
      return empty();
    }
    if (text.startsWith('SELECT owner_id, refresh_token_enc')) {
      const row = tables.hostTokens.get(String(params[0]));
      return rowsOf(row === undefined ? [] : [row]);
    }

    // ---- bookings: reads --------------------------------------------------
    if (text === SELECT_BY_ID || text === SELECT_BY_ID_FOR_UPDATE) {
      const row = tables.bookings.get(String(params[0]));
      return rowsOf(row === undefined ? [] : [row]);
    }
    if (text === SELECT_BY_TOKEN) {
      return rowsOf([...tables.bookings.values()].filter((row) => row.token === params[0]));
    }
    if (text === SELECT_BY_KEY) {
      return rowsOf(
        [...tables.bookings.values()].filter(
          (row) => row.owner_id === params[0] && row.idempotency_key === params[1],
        ),
      );
    }
    if (text.includes('FROM bookings') && text.includes('unresolved_inserts @>')) {
      const eventId = String(params[0]);
      const match = [...tables.bookings.values()].find(
        (row) =>
          row.google_event_id === eventId ||
          readJson<Array<{ eventId?: string }>>(row.unresolved_inserts, []).some(
            (entry) => entry.eventId === eventId,
          ),
      );
      return rowsOf(match === undefined ? [] : [match]);
    }
    if (text === OCCUPANCY_SQL) {
      return rowsOf(occupancyRows(tables, params));
    }

    // ---- bookings: writes -------------------------------------------------
    if (text.startsWith('INSERT INTO bookings')) {
      return rowsOf([insertBooking(tables, params)]);
    }
    if (text === SELECT_FENCE) {
      const row = tables.rejections.get(fenceKey(params[0], params[1], params[2]));
      return rowsOf(row === undefined ? [] : [{ reason: row.reason }]);
    }
    if (text === INSERT_FENCE) {
      const key = fenceKey(params[0], params[1], params[2]);
      if (!tables.rejections.has(key)) {
        tables.rejections.set(key, {
          owner_id: params[0],
          idempotency_key: params[1],
          create_fingerprint: params[2],
          reason: params[3],
          rejected_at: new Date().toISOString(),
        });
      }
      return empty();
    }
    if (text === STAMP_REAP_SQL) {
      return stampReap(tables, params);
    }
    if (text === RETIRE_ATTEMPT_SQL) {
      return retireAttempt(tables, params);
    }
    if (text.startsWith('UPDATE bookings') && text.includes("jsonb_build_object('gen'")) {
      return takeOver(tables, params);
    }
    // Order matters: `resolveAttempt` also mentions `pending_op->'attempts'`,
    // so it must be recognised before the plain append.
    if (text.startsWith('UPDATE bookings') && text.includes("entry->>'attemptId' = $3")) {
      return resolveAttempt(tables, params);
    }
    if (text.startsWith('UPDATE bookings') && text.includes("pending_op->'attempts'")) {
      return appendAttempt(tables, params);
    }
    if (text.startsWith('UPDATE bookings SET ')) {
      return genericUpdate(tables, text, params);
    }

    // ---- ledger -----------------------------------------------------------
    if (text === CLAIM_SQL) {
      return claimDelivery(tables, params);
    }
    if (text === FINALIZE_SQL) {
      return finalizeDelivery(tables, params);
    }
    if (text.includes('FROM notification_deliveries')) {
      return rowsOf(
        [...tables.deliveries.values()].filter(
          (row) =>
            row.booking_id === params[0] &&
            Number(row.revision) === Number(params[1]) &&
            row.action === params[2],
        ),
      );
    }

    throw new Error(`pg-fake: unhandled statement:\n${sql}`);
  }

  function runSchemaQuery(queryOptions?: QueryOptions): Promise<QueryResult> {
    const behaviour: SchemaQueryBehaviour =
      schemaQuery ??
      (tables.migrations.length === 0
        ? { kind: 'empty' }
        : { kind: 'rows', version: Math.max(...tables.migrations) });

    if (behaviour.kind === 'rows') {
      return Promise.resolve(rowsOf([{ version: behaviour.version }]));
    }
    if (behaviour.kind === 'empty') {
      return Promise.resolve(empty());
    }
    if (behaviour.kind === 'missing-table') {
      const error = new Error('relation "schema_migrations" does not exist') as Error & {
        code?: string;
      };
      error.code = '42P01';
      return Promise.reject(error);
    }
    if (behaviour.kind === 'error') {
      const error = new Error('connection refused') as Error & { code?: string };
      error.code = behaviour.code;
      return Promise.reject(error);
    }
    // `stall`: never answers. The route's own deadline must fire.
    void queryOptions;
    return new Promise<QueryResult>(() => {});
  }

  function commit(state: ConnState): Promise<QueryResult> {
    const targeted =
      nextCommitMatching === null ||
      state.txStatements.some((sql) => sql.includes(nextCommitMatching as string));
    const outcome = targeted ? nextCommit : 'ok';
    if (targeted) {
      nextCommit = 'ok';
      nextCommitMatching = null;
    }

    if (outcome === 'ok') {
      endTransaction(state);
      return Promise.resolve(empty());
    }
    if (outcome === 'definite') {
      if (state.snapshot !== null) {
        tables = state.snapshot;
      }
      endTransaction(state);
      return Promise.reject(definiteCommitError());
    }
    if (outcome === 'unknown-committed') {
      endTransaction(state);
      return Promise.reject(connectionResetError());
    }
    if (outcome === 'unknown-rolled-back') {
      if (state.snapshot !== null) {
        tables = state.snapshot;
      }
      endTransaction(state);
      return Promise.reject(connectionResetError());
    }

    // Delayed completion (C6.5): the caller loses the response now, but the
    // server-side transaction — and its advisory lock — stays open, so a
    // reconciler that tries to reacquire the lock genuinely blocks.
    const snapshot = state.snapshot;
    const hosts = [...state.heldHosts];
    const timer = setTimeout(() => {
      if (outcome.as === 'rollback' && snapshot !== null) {
        tables = snapshot;
      }
      for (const hostId of hosts) {
        locks.release(hostId, state.id);
      }
    }, outcome.resolveAfterMs);
    // Deliberately NOT unref'd: this timer is what releases the reconciler
    // blocked on the lock, so the event loop must stay alive for it.
    void timer;
    state.inTransaction = false;
    state.snapshot = null;
    state.heldHosts = [];
    state.lockTimeoutMs = null;
    state.txStatements = [];
    return Promise.reject(connectionResetError());
  }

  function endTransaction(state: ConnState): void {
    state.inTransaction = false;
    state.snapshot = null;
    state.lockTimeoutMs = null;
    state.txStatements = [];
    state.aborted = false;
    state.savepoints = [];
    for (const hostId of state.heldHosts) {
      locks.release(hostId, state.id);
    }
    state.heldHosts = [];
  }

  function makeConnection(): Connection & { state: ConnState } {
    connectionSeq += 1;
    const state: ConnState = {
      id: `conn-${connectionSeq}`,
      inTransaction: false,
      snapshot: null,
      lockTimeoutMs: null,
      heldHosts: [],
      txStatements: [],
      aborted: false,
      savepoints: [],
    };
    opened.push(state.id);
    return {
      connectionId: state.id,
      state,
      query: (sql, params = [], queryOptions) => execute(state, sql, params, queryOptions) as Promise<QueryResult<never>>,
      release: async () => {
        // A released connection must never keep a lock: an abandoned
        // transaction is rolled back by the server.
        if (state.inTransaction && state.snapshot !== null) {
          tables = state.snapshot;
        }
        endTransaction(state);
      },
    } as Connection & { state: ConnState };
  }

  // Statements issued outside an explicit transaction still need a connection
  // identity for the log; one implicit connection serves them all.
  const implicit = makeConnection();

  const db: FakeDatabase = {
    statements,
    locks,
    query: (sql, params = [], queryOptions) =>
      execute(implicit.state, sql, params, queryOptions) as Promise<QueryResult<never>>,
    connect: async () => makeConnection(),
    sqlLog: () => statements.map((entry) => entry.sql),
    statementsOn: (table) => statements.filter((entry) => entry.sql.includes(table)),
    clearLog: () => {
      statements.length = 0;
    },
    setNextCommitOutcome: (outcome, commitOptions) => {
      nextCommit = outcome;
      nextCommitMatching = commitOptions?.matching ?? null;
    },
    failNextStatement: (matching, failOptions) => {
      scriptedFailure = { matching, code: failOptions?.code ?? '23505' };
    },
    setSchemaQuery: (behaviour) => {
      schemaQuery = behaviour;
    },
    connectionsOpened: () => [...opened],
    tables: () => tables,
    seedMigration: (version = LATEST_SCHEMA_VERSION) => {
      tables.migrations.push(version);
    },
    seedOwner: (row) => {
      tables.owners.set(String(row.id), row);
    },
    seedHostToken: (row) => {
      tables.hostTokens.set(String(row.owner_id), row);
    },
    seedEventType: (row) => {
      tables.eventTypes.set(String(row.id), row);
    },
    seedSchedule: (row) => {
      tables.schedules.set(String(row.id), row);
    },
    seedBooking: (row) => {
      tables.bookings.set(String(row.id), row);
    },
    booking: (id) => tables.bookings.get(id),
    deliveries: () => [...tables.deliveries.values()],
    rejections: () => [...tables.rejections.values()],
  };
  return db;
}

/**
 * Postgres infers each placeholder's type from its use, so `$1,$2,$4` with five
 * arguments is a **parse error** — "could not determine data type of parameter
 * $3" — whatever the statement then does with the values. The fake enforces the
 * same two rules the server does: every `$n` must have an argument, and every
 * argument must be referenced.
 */
function assertPlaceholdersContiguous(sql: string, params: readonly unknown[]): void {
  const referenced = new Set<number>();
  for (const match of sql.matchAll(/\$(\d+)/g)) {
    referenced.add(Number(match[1]));
  }
  if (referenced.size === 0 && params.length === 0) {
    return;
  }
  const highest = referenced.size === 0 ? 0 : Math.max(...referenced);
  for (let index = 1; index <= highest; index += 1) {
    if (!referenced.has(index)) {
      throw new Error(
        `pg-fake: could not determine data type of parameter $${index} (placeholder gap in: ${sql})`,
      );
    }
  }
  if (highest !== params.length) {
    throw new Error(
      `pg-fake: statement references $1..$${highest} but ${params.length} parameters were bound (${sql})`,
    );
  }
}

// ---- statement implementations -------------------------------------------

function empty(): QueryResult {
  return { rows: [], rowCount: 0 };
}

function rowsOf(rows: Row[]): QueryResult {
  return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
}

function fenceKey(ownerId: unknown, key: unknown, fingerprint: unknown): string {
  return `${String(ownerId)}\u0000${String(key)}\u0000${String(fingerprint)}`;
}

function readJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function insertBooking(tables: Tables, params: readonly unknown[]): Row {
  const row: Row = {
    id: params[0],
    token: params[1],
    idempotency_key: params[2],
    create_fingerprint: params[3],
    owner_id: params[4],
    event_type_id: params[5],
    host_id: params[6],
    start: params[7],
    end: params[8],
    status: 'confirmed',
    revision: 1,
    latest_action: null,
    google_event_id: params[9],
    google_event_etag: null,
    calendar_state: 'pending',
    pending_op: params[10],
    unfinished_create: null,
    unresolved_inserts: '[]',
    reap_cursor: 0,
    rescheduled_from: null,
    reserved_start: null,
    reserved_end: null,
    invitee_name: params[11],
    invitee_email: params[12],
    notes: params[13],
    metadata: params[14],
    created_at: params[15],
  };
  tables.bookings.set(String(params[0]), row);
  return row;
}

function occupancyRows(tables: Tables, params: readonly unknown[]): Row[] {
  const [hostId, windowStart, windowEnd, excludeId] = params;
  const from = Date.parse(String(windowStart));
  const to = Date.parse(String(windowEnd));
  return [...tables.bookings.values()].filter((row) => {
    if (row.host_id !== hostId) return false;
    if (excludeId !== null && excludeId !== undefined && row.id === excludeId) return false;
    const confirmedOverlap =
      row.status === 'confirmed' &&
      Date.parse(String(row.start)) < to &&
      Date.parse(String(row.end)) > from;
    const reservedOverlap =
      row.reserved_start !== null &&
      row.reserved_start !== undefined &&
      Date.parse(String(row.reserved_start)) < to &&
      Date.parse(String(row.reserved_end)) > from;
    return confirmedOverlap || reservedOverlap;
  });
}

/**
 * The dynamic `UPDATE bookings SET …` of `PgTx.update`. Parsed rather than
 * pattern-matched, because the SET list depends on the patch — and the WHERE
 * clause is exactly the conditional-update contract of C6.3 / AC-18.
 */
function genericUpdate(tables: Tables, text: string, params: readonly unknown[]): QueryResult {
  const setStart = text.indexOf(' SET ') + ' SET '.length;
  const whereStart = text.indexOf(' WHERE ');
  const setClause = text.slice(setStart, whereStart);
  const whereClause = text.slice(whereStart + ' WHERE '.length);

  const row = tables.bookings.get(String(params[0]));
  if (row === undefined) {
    return empty();
  }
  if (Number(row.revision) !== Number(params[1])) {
    return empty();
  }
  if (whereClause.includes("status = 'confirmed'") && row.status !== 'confirmed') {
    return empty();
  }

  const opIdMatch = whereClause.match(/pending_op->>'opId' = \$(\d+)/);
  const genMatch = whereClause.match(/\(pending_op->>'gen'\)::int = \$(\d+)/);
  if (opIdMatch !== null) {
    const op = readJson<{ opId?: string; gen?: number } | null>(row.pending_op, null);
    const wantedOpId = params[Number(opIdMatch[1]) - 1];
    if (op === null || op.opId !== wantedOpId) {
      return empty();
    }
    if (genMatch !== null) {
      const wantedGen = Number(params[Number(genMatch[1]) - 1]);
      if (Number(op.gen) !== wantedGen) {
        return empty();
      }
    }
  }

  for (const assignment of splitAssignments(setClause)) {
    if (assignment === 'revision = revision + 1') {
      row.revision = Number(row.revision) + 1;
      continue;
    }
    const match = assignment.match(/^(.+?) = \$(\d+)$/);
    if (match === null) {
      throw new Error(`pg-fake: unparsed assignment "${assignment}"`);
    }
    const column = match[1].replace(/"/g, '');
    row[column] = params[Number(match[2]) - 1];
  }
  return { rows: [], rowCount: 1 };
}

/** Splits on top-level commas (the SET list has no nested parentheses). */
function splitAssignments(clause: string): string[] {
  return clause
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function takeOver(tables: Tables, params: readonly unknown[]): QueryResult {
  const [id, opId, gen, startedAt] = params;
  const row = tables.bookings.get(String(id));
  if (row === undefined) {
    return empty();
  }
  const op = readJson<{ opId?: string; gen?: number } | null>(row.pending_op, null);
  if (op === null || op.opId !== opId || Number(op.gen) !== Number(gen)) {
    return empty();
  }
  row.pending_op = JSON.stringify({ ...op, gen: Number(gen) + 1, startedAt });
  return { rows: [], rowCount: 1 };
}

function appendAttempt(tables: Tables, params: readonly unknown[]): QueryResult {
  const [id, opId, gen, attemptJson] = params;
  const row = tables.bookings.get(String(id));
  if (row === undefined) {
    return empty();
  }
  const op = readJson<{ opId?: string; gen?: number; attempts?: unknown[] } | null>(
    row.pending_op,
    null,
  );
  if (op === null || op.opId !== opId || Number(op.gen) !== Number(gen)) {
    return empty();
  }
  const appended = readJson<unknown[]>(attemptJson, []);
  op.attempts = [...(op.attempts ?? []), ...appended];
  row.pending_op = JSON.stringify(op);
  return { rows: [], rowCount: 1 };
}

function resolveAttempt(tables: Tables, params: readonly unknown[]): QueryResult {
  const [id, opId, attemptId, outcome, resolvedAt] = params;
  const row = tables.bookings.get(String(id));
  if (row === undefined) {
    return empty();
  }
  const op = readJson<{
    opId?: string;
    attempts?: Array<Record<string, unknown>>;
  } | null>(row.pending_op, null);
  if (op === null || op.opId !== opId) {
    return empty();
  }
  op.attempts = (op.attempts ?? []).map((entry) =>
    entry.attemptId === attemptId && entry.outcome === 'unresolved'
      ? { ...entry, outcome, resolvedAt }
      : entry,
  );
  row.pending_op = JSON.stringify(op);
  return { rows: [], rowCount: 1 };
}

function stampReap(tables: Tables, params: readonly unknown[]): QueryResult {
  const [id, batchJson, inspectedAt] = params;
  const row = tables.bookings.get(String(id));
  if (row === undefined) {
    return empty();
  }
  const batch = readJson<string[]>(batchJson, []);
  const cursor = Number(row.reap_cursor ?? 0);
  const entries = readJson<Array<Record<string, unknown>>>(row.unresolved_inserts, []);
  row.unresolved_inserts = JSON.stringify(
    entries.map((entry) => {
      const ordinality = batch.indexOf(String(entry.eventId)) + 1;
      if (ordinality === 0) {
        return entry;
      }
      return { ...entry, inspectSeq: cursor + ordinality, inspectedAt };
    }),
  );
  row.reap_cursor = cursor + batch.length;
  return rowsOf([{ reap_cursor: row.reap_cursor }]);
}

function retireAttempt(tables: Tables, params: readonly unknown[]): QueryResult {
  const [id, attemptId] = params;
  const row = tables.bookings.get(String(id));
  if (row === undefined) {
    return empty();
  }
  const entries = readJson<Array<Record<string, unknown>>>(row.unresolved_inserts, []);
  row.unresolved_inserts = JSON.stringify(
    entries.filter((entry) => entry.attemptId !== attemptId),
  );
  return { rows: [], rowCount: 1 };
}

function deliveryKey(params: readonly unknown[]): string {
  return [params[0], params[1], params[2], params[3]].map(String).join('\u0000');
}

/**
 * The C5 claim, with the two re-claim conditions kept apart: a `failed` row is
 * re-claimable **immediately** (no age condition), a `claimed` row only after
 * the stale window (REV7-04).
 */
function claimDelivery(tables: Tables, params: readonly unknown[]): QueryResult {
  const key = deliveryKey(params);
  const nowIso = String(params[4]);
  const staleCutoff = Date.parse(String(params[5]));
  const existing = tables.deliveries.get(key);

  if (existing === undefined) {
    const row: Row = {
      booking_id: params[0],
      revision: params[1],
      action: params[2],
      recipient: params[3],
      state: 'claimed',
      claimed_at: nowIso,
      attempts: 1,
    };
    tables.deliveries.set(key, row);
    return rowsOf([{ attempts: 1 }]);
  }

  const reclaimable =
    existing.state === 'failed' ||
    (existing.state === 'claimed' && Date.parse(String(existing.claimed_at)) < staleCutoff);
  if (!reclaimable) {
    return empty();
  }
  existing.state = 'claimed';
  existing.claimed_at = nowIso;
  existing.attempts = Number(existing.attempts) + 1;
  return rowsOf([{ attempts: existing.attempts }]);
}

/** Generation-conditioned: a late finaliser after a takeover updates nothing. */
function finalizeDelivery(tables: Tables, params: readonly unknown[]): QueryResult {
  const key = deliveryKey(params);
  const existing = tables.deliveries.get(key);
  if (
    existing === undefined ||
    existing.state !== 'claimed' ||
    Number(existing.attempts) !== Number(params[4])
  ) {
    return empty();
  }
  existing.state = params[5];
  return { rows: [], rowCount: 1 };
}
