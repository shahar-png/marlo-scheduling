// C13 — the bounded `schema_migrations` readiness query.
//
// Exactly **one** statement per request, on the same `Queryable` the store
// uses, with no cached observation of any kind: the first request a fresh
// isolate serves and the thousandth compute `schema` the same way, so
// `/api/health` can never report a green deploy on a database the store would
// then refuse to serve with `store_not_migrated` (REV9-03).

import { LATEST_SCHEMA_VERSION } from './schema-version';
import { systemClock, type Clock } from '../clock';
import type { Queryable } from './index';

export const HEALTH_DB_TIMEOUT_MS = 2000;

export const READINESS_SQL =
  'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1';

/** `42P01` = undefined_table: `schema_migrations` does not exist yet. */
const UNDEFINED_TABLE = '42P01';

export type SchemaState = 'current' | 'behind' | 'missing' | 'unknown' | 'n/a';
export type DbState = 'ok' | 'unreachable' | 'n/a';

export type SchemaReadiness = {
  schema: SchemaState;
  db: DbState;
};

export type HealthSchemaOptions = {
  timeoutMs?: number;
  latestVersion?: number;
  clock?: Clock;
};

export async function healthSchema(
  db: Queryable,
  options: HealthSchemaOptions = {},
): Promise<SchemaReadiness> {
  const timeoutMs = options.timeoutMs ?? HEALTH_DB_TIMEOUT_MS;
  const latest = options.latestVersion ?? LATEST_SCHEMA_VERSION;
  const clock = options.clock ?? systemClock;

  const deadline = clock.sleep(timeoutMs).then(() => DEADLINE);
  let answered: unknown;
  try {
    answered = await Promise.race([
      // One statement, bounded on the server too, so a stalled query is
      // abandoned at both ends.
      db.query<{ version: unknown }>(READINESS_SQL, [], {
        statementTimeoutMs: timeoutMs,
      }),
      deadline,
    ]);
  } catch (error) {
    if (codeOf(error) === UNDEFINED_TABLE) {
      // An empty database: reachable, but nothing has been migrated.
      return { schema: 'missing', db: 'ok' };
    }
    return { schema: 'unknown', db: 'unreachable' };
  }

  if (answered === DEADLINE) {
    return { schema: 'unknown', db: 'unreachable' };
  }

  const rows = (answered as { rows?: { version: unknown }[] }).rows ?? [];
  if (rows.length === 0) {
    return { schema: 'missing', db: 'ok' };
  }
  const version = Number(rows[0]?.version);
  if (!Number.isFinite(version)) {
    return { schema: 'unknown', db: 'ok' };
  }
  if (version >= latest) {
    return { schema: 'current', db: 'ok' };
  }
  return { schema: 'behind', db: 'ok' };
}

/** `ok` is true iff the schema can serve traffic (C13). */
export function healthOk(schema: SchemaState): boolean {
  return schema === 'current' || schema === 'n/a';
}

const DEADLINE = Symbol('health-deadline');

function codeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return null;
}
