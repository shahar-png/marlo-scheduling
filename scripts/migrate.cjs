'use strict';

// `npm run db:migrate` (C8 / AC-17). Applies every `sql/*.sql` file in
// filename order, each inside one transaction, skipping versions already
// recorded in `schema_migrations` — so a second run applies nothing.
//
// The runner is pure with respect to its I/O: `applyMigrations()` takes a
// `Queryable` and the file list, so the unit test drives it against the fake
// with no database (AC-17).

const { readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SQL_DIR = path.join(root, 'sql');
const FILENAME = /^(\d+)_.+\.sql$/;

function listMigrations(dir = SQL_DIR, read = readdirSync, readFile = readFileSync) {
  return read(dir)
    .filter((name) => FILENAME.test(name))
    .sort()
    .map((name) => ({
      version: Number(FILENAME.exec(name)[1]),
      name,
      sql: readFile(path.join(dir, name), 'utf8'),
    }));
}

async function appliedVersions(db) {
  try {
    const result = await db.query(
      'SELECT version FROM schema_migrations ORDER BY version ASC',
    );
    return new Set((result.rows || []).map((row) => Number(row.version)));
  } catch (error) {
    // `42P01` (undefined_table) on an empty database: nothing is applied yet.
    if (error && error.code === '42P01') {
      return new Set();
    }
    throw error;
  }
}

async function applyMigrations(db, options = {}) {
  const migrations = options.migrations || listMigrations();
  const log = options.log || console.log;
  const already = await appliedVersions(db);
  const applied = [];

  for (const migration of migrations) {
    if (already.has(migration.version)) {
      continue;
    }
    const connection = await db.connect();
    try {
      await connection.query('BEGIN');
      await connection.query(migration.sql);
      await connection.query(
        'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
        [migration.version],
      );
      await connection.query('COMMIT');
    } catch (error) {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // already gone
      }
      throw error;
    } finally {
      await connection.release();
    }
    applied.push(migration.version);
    log(`migrate: applied ${migration.name}`);
  }

  if (applied.length === 0) {
    log('migrate: schema already current');
  }
  return applied;
}

module.exports = { applyMigrations, listMigrations, appliedVersions };

if (require.main === module) {
  // The CLI is the only place a driver is needed; the proof never runs it.
  (async () => {
    const url = process.env.DATABASE_URL;
    if (!url) {
      console.error('migrate: DATABASE_URL is required');
      process.exit(2);
    }
    let createDatabase;
    try {
      ({ createDatabase } = require('./pg-driver.cjs'));
    } catch (error) {
      console.error(`migrate: ${error.message}`);
      process.exit(2);
    }
    const db = await createDatabase(url);
    try {
      await applyMigrations(db);
    } finally {
      if (typeof db.end === 'function') {
        await db.end();
      }
    }
  })().catch((error) => {
    console.error(`migrate: ${error && error.message ? error.message : error}`);
    process.exit(1);
  });
}
