// The production Postgres driver bridge.
//
// The whole durable path is written against the `Queryable` seam, so `npm test`
// proves it offline against the recording fake and never needs a driver, a
// `DATABASE_URL`, or the network (AC-6). A real deployment needs exactly one
// driver package, which is loaded here.
//
// The specifier is **computed**, so neither `next build` nor `tsc` tries to
// resolve it and a deployment without a driver fails with one clear
// `store_driver_unavailable` instead of a bundler error. `createRequire` (not
// `eval`) is what makes that resolution work from both CJS and ESM output.

import { createRequire } from 'node:module';
import type { Connection, Database, QueryResult } from './index';

/** Either driver exposes the `Pool` surface this bridge needs. */
export const DRIVER_CANDIDATES = ['pg', '@neondatabase/serverless'] as const;

type DriverResult = { rows?: unknown[]; rowCount?: number | null; command?: string };

type DriverClient = {
  query(config: unknown, values?: unknown[]): Promise<DriverResult>;
  /** `release(true)` destroys the client instead of returning it to the pool. */
  release(destroy?: boolean): void;
};

type DriverPool = {
  connect(): Promise<DriverClient>;
  end(): Promise<void>;
};

/**
 * Only the options this bridge sets. `statement_timeout` and
 * `connectionTimeoutMillis` are **connection**-level settings in `pg`; passing
 * a timeout on a per-query config object is silently ignored (REVIEW-03).
 */
type DriverPoolConfig = {
  connectionString: string;
  statement_timeout?: number;
  query_timeout?: number;
  connectionTimeoutMillis?: number;
  max?: number;
};

type DriverModule = {
  Pool: new (config: DriverPoolConfig) => DriverPool;
};

export class DriverUnavailableError extends Error {
  readonly code = 'store_driver_unavailable';
  constructor(tried: string[]) {
    super(
      `store_driver_unavailable: install one of ${DRIVER_CANDIDATES.join(' or ')} ` +
        `(tried ${tried.join(', ')})`,
    );
    this.name = 'DriverUnavailableError';
  }
}

function loadDriver(): DriverModule {
  const require = createRequire(`${process.cwd()}/package.json`);
  const tried: string[] = [];
  for (const candidate of DRIVER_CANDIDATES) {
    try {
      // Computed specifier: invisible to bundlers and to the typechecker.
      const name: string = candidate;
      const loaded = require(name) as Partial<DriverModule>;
      if (typeof loaded?.Pool === 'function') {
        return loaded as DriverModule;
      }
      tried.push(`${candidate}: no Pool export`);
    } catch (error) {
      tried.push(`${candidate}: ${codeOf(error)}`);
    }
  }
  throw new DriverUnavailableError(tried);
}

function normalise(result: DriverResult): QueryResult {
  const rows = (result.rows ?? []) as Record<string, unknown>[];
  return {
    rows,
    rowCount: result.rowCount ?? rows.length,
    // Carried through because `withTransaction` must tell a real `COMMIT` from
    // one the server answered `ROLLBACK` (REVIEW-01).
    ...(result.command === undefined ? {} : { command: result.command }),
  };
}

/**
 * A pooled {@link Database} over the loaded driver. `connect()` hands out an
 * identifiable connection because C6.5's reconciliation must reacquire the host
 * advisory lock on a **fresh** one.
 */
export function createPgDatabase(connectionString: string): Database & { end(): Promise<void> } {
  const Pool = loadDriver().Pool;
  const pool = new Pool({ connectionString });
  let connectionSeq = 0;

  /**
   * C13's bounded readiness query runs on its own small pool whose **connection
   * configuration** carries the timeout, because that is where `pg` accepts it:
   * a `statement_timeout` on a per-query config object is ignored, leaving the
   * route's `Promise.race` as the only bound — it answers, but the SQL keeps
   * running and the pool connection stays checked out (REVIEW-03).
   *
   * `connectionTimeoutMillis` bounds *acquisition* by the same deadline, and a
   * client whose query timed out is **destroyed** rather than returned, so a
   * blocked database cannot retain connections one readiness check at a time.
   * It is still exactly one statement per request.
   */
  const bounded = new Map<number, DriverPool>();
  const boundedPool = (timeoutMs: number): DriverPool => {
    const existing = bounded.get(timeoutMs);
    if (existing !== undefined) {
      return existing;
    }
    const created = new Pool({
      connectionString,
      statement_timeout: timeoutMs,
      query_timeout: timeoutMs,
      connectionTimeoutMillis: timeoutMs,
      max: 2,
    });
    bounded.set(timeoutMs, created);
    return created;
  };

  const run = async (
    client: DriverClient,
    sql: string,
    params?: readonly unknown[],
  ): Promise<QueryResult> => {
    const values = params === undefined ? undefined : [...params];
    return normalise(await client.query(sql, values));
  };

  return {
    async query(sql, params, options) {
      const timeoutMs = options?.statementTimeoutMs;
      if (timeoutMs !== undefined) {
        const client = await boundedPool(timeoutMs).connect();
        let failed = false;
        try {
          return (await run(client, sql, params)) as QueryResult<never>;
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          client.release(failed);
        }
      }
      const client = await pool.connect();
      try {
        return (await run(client, sql, params)) as QueryResult<never>;
      } finally {
        client.release();
      }
    },
    async connect(): Promise<Connection> {
      connectionSeq += 1;
      const id = `pg-${connectionSeq}`;
      const client = await pool.connect();
      let released = false;
      return {
        connectionId: id,
        query: (sql, params) => run(client, sql, params) as Promise<QueryResult<never>>,
        async release() {
          if (!released) {
            released = true;
            client.release();
          }
        },
      };
    },
    async end() {
      await pool.end();
      for (const extra of bounded.values()) {
        await extra.end();
      }
    },
  };
}

function codeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  return 'load failed';
}
