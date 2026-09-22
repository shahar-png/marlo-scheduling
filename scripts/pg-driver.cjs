'use strict';

// Optional Postgres driver bridge. The durable store and the migration runner
// are written against the `Queryable` seam (lib/db), so the whole pg path is
// proven offline against the recording fake and `npm test` never needs a
// driver, a DATABASE_URL, or the network (AC-6).
//
// A real deployment needs one driver package. It is loaded through a computed
// specifier so neither `next build` nor `tsc` tries to resolve it, and a
// missing driver produces one clear error instead of a stack trace.

const CANDIDATES = ['pg', '@neondatabase/serverless'];

function loadDriver() {
  const failures = [];
  for (const name of CANDIDATES) {
    try {
      // Computed specifier: invisible to bundlers and to the typechecker.
      // eslint-disable-next-line import/no-dynamic-require
      return { name, module: require(String(name)) };
    } catch (error) {
      failures.push(`${name}: ${error && error.code ? error.code : 'load failed'}`);
    }
  }
  throw new Error(
    'store_driver_unavailable: install one of ' +
      CANDIDATES.join(' or ') +
      ` (tried ${failures.join(', ')})`,
  );
}

async function createDatabase(connectionString) {
  const { module: driver } = loadDriver();
  const pool = new driver.Pool({ connectionString });

  const wrap = (client, release) => ({
    connectionId: `conn-${Math.random().toString(36).slice(2)}`,
    async query(sql, params, options) {
      if (options && options.statementTimeoutMs) {
        // Per-query bound; `SET LOCAL` would be a second statement, so the
        // driver-level option is used where it exists.
        return client.query({
          text: sql,
          values: params ? [...params] : undefined,
          statement_timeout: options.statementTimeoutMs,
        });
      }
      return client.query(sql, params ? [...params] : undefined);
    },
    async release() {
      if (release) {
        release();
      }
    },
  });

  return {
    async query(sql, params, options) {
      const client = await pool.connect();
      try {
        return await wrap(client, null).query(sql, params, options);
      } finally {
        client.release();
      }
    },
    async connect() {
      const client = await pool.connect();
      return wrap(client, () => client.release());
    },
    async end() {
      await pool.end();
    },
  };
}

module.exports = { createDatabase, loadDriver, CANDIDATES };
