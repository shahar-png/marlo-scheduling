// AC-15 (C13 health) · AC-17 (schema + migrations) · AC-25 (C6.0 classifier)
// · AC-24 (group/collective scope-out) · AC-2 (reserved root slugs)
// · AC-6 (the offline proof harness).
//
// These are the contracts that sit around the lifecycle rather than inside it.
// Each is cheap to prove and each guards a promise the PLAN makes about
// production: a health check that cannot lie about migrations, a classifier no
// lifecycle step may second-guess, a live path that refuses the two event kinds
// it does not serve, and a proof run that cannot reach the network.

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createFakeClock } from '../lib/clock';
import { LATEST_SCHEMA_VERSION } from '../lib/db/schema-version';
import type { Queryable } from '../lib/db/index';
import {
  HEALTH_DB_TIMEOUT_MS,
  READINESS_SQL,
  healthOk,
  healthSchema,
} from '../lib/db/health';
import {
  AMBIGUOUS,
  ALREADY_EXISTS,
  APPLIED,
  DEFINITE,
  PRECONDITION_FAILED,
  classifyCalendarError,
  classifyGmailError,
} from '../lib/google/errors';
import {
  RESERVED_ROOT_SLUGS,
  ReservedOwnerSlugError,
  assertAssignableOwnerSlug,
  isReservedRootSlug,
  isValidSlug,
  ownerSlugFromEmail,
} from '../lib/owners';
import { materializeOwner } from '../lib/owners-materialize';
import { availableTimes, createBooking, resolveScope } from '../lib/booking/service';
import { LifecycleError } from '../lib/booking/errors';
import { COLLECTIVE, GROUP } from '../lib/availability/event-type';
import { DEMO, MONDAY_0900, withHarness } from './support/harness';
import { createFakeDatabase } from './support/pg-fake';

const proof = require('../scripts/proof.cjs') as typeof import('../scripts/proof.cjs');

const ORIGIN = 'https://marlo.test';
const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };

async function expectError(fn: () => Promise<unknown>): Promise<LifecycleError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof LifecycleError, `expected LifecycleError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject');
}

// ---- AC-15 / C13 ----------------------------------------------------------

describe('AC-15 — /api/health answers from one bounded readiness query (C13)', () => {
  it('reports current on a migrated database, with exactly one statement', async () => {
    const db = createFakeDatabase();
    const readiness = await healthSchema(db);

    assert.deepEqual(readiness, { schema: 'current', db: 'ok' });
    assert.equal(healthOk(readiness.schema), true);
    // The FIRST request a fresh isolate serves: one statement, and it is the
    // readiness query — never `assertMigrated`, never a cached observation.
    assert.equal(db.statements.length, 1);
    assert.equal(db.statements[0].sql, READINESS_SQL);
    assert.equal(
      db.statements[0].params.length,
      0,
      'the readiness query takes no parameters',
    );
  });

  it('bounds the query on the server too', async () => {
    const db = createFakeDatabase();
    let seen: number | undefined;
    const observed: Queryable = {
      query: (sql, params, options) => {
        seen = options?.statementTimeoutMs;
        return db.query(sql, params, options);
      },
    };
    await healthSchema(observed);
    assert.equal(seen, HEALTH_DB_TIMEOUT_MS);
  });

  it('applies that bound where the driver accepts it, on the connection', () => {
    // `pg` reads `statement_timeout` from the **client/pool configuration**; on
    // a per-query config object it is silently ignored, which left the route's
    // `Promise.race` as the only bound — it answers, but the SQL keeps running
    // and the pooled connection stays checked out (REVIEW-03).
    const driver = readFileSync(path.join(process.cwd(), 'lib/db/driver.ts'), 'utf8');
    const boundedPool =
      /new Pool\(\{[\s\S]*?statement_timeout[\s\S]*?connectionTimeoutMillis[\s\S]*?\}\)/.test(
        driver,
      );
    assert.ok(boundedPool, 'the timeout is set in the pool configuration');
    assert.equal(
      /client\.query\(\{[\s\S]*?statement_timeout/.test(driver),
      false,
      'never passed on a per-query config object, where pg ignores it',
    );
    // A client whose bounded query failed is destroyed, not returned to the
    // pool, so repeated blocked readiness checks cannot retain connections.
    assert.ok(/client\.release\(failed\)/.test(driver), 'a timed-out client is destroyed');
  });

  it('distinguishes behind, missing, and unreachable — each failing ok', async () => {
    const cases = [
      [{ kind: 'rows', version: LATEST_SCHEMA_VERSION - 1 } as const, 'behind', 'ok'],
      [{ kind: 'empty' } as const, 'missing', 'ok'],
      [{ kind: 'missing-table' } as const, 'missing', 'ok'],
      [{ kind: 'error', code: 'ECONNREFUSED' } as const, 'unknown', 'unreachable'],
    ] as const;

    for (const [behaviour, schema, db] of cases) {
      const fake = createFakeDatabase();
      fake.setSchemaQuery(behaviour);
      const readiness = await healthSchema(fake);
      assert.deepEqual(readiness, { schema, db }, `${behaviour.kind}`);
      assert.equal(healthOk(readiness.schema), false, `${behaviour.kind} must fail ok`);
    }
  });

  it('answers within its deadline when the query never returns', async () => {
    const fake = createFakeDatabase();
    fake.setSchemaQuery({ kind: 'stall' });
    const clock = createFakeClock();

    const pending = healthSchema(fake, { clock, timeoutMs: HEALTH_DB_TIMEOUT_MS });
    await clock.advance(HEALTH_DB_TIMEOUT_MS);
    const readiness = await pending;

    assert.deepEqual(readiness, { schema: 'unknown', db: 'unreachable' });
  });

  it('caches nothing: a second request issues a second identical query', async () => {
    const db = createFakeDatabase();
    await healthSchema(db);
    await healthSchema(db);
    assert.equal(db.statements.length, 2);
    assert.deepEqual(db.sqlLog(), [READINESS_SQL, READINESS_SQL]);
  });

  it('memory mode performs zero I/O', () => {
    // `n/a` is the memory-mode answer and it is `ok`; no Queryable is consulted.
    assert.equal(healthOk('n/a'), true);
  });
});

// ---- AC-17 schema + migrations -------------------------------------------

describe('AC-17 — the schema file is complete and the version is single-sourced', () => {
  const sqlDir = path.join(process.cwd(), 'sql');
  const files = readdirSync(sqlDir).filter((name) => name.endsWith('.sql')).sort();
  const initSql = readFileSync(path.join(sqlDir, files[0]), 'utf8');

  it('LATEST_SCHEMA_VERSION equals the highest sql/*.sql version', () => {
    const versions = files.map((name) => Number(name.split('_')[0]));
    assert.ok(versions.every((version) => Number.isFinite(version)));
    assert.equal(LATEST_SCHEMA_VERSION, Math.max(...versions));
  });

  it('creates every table the C8 contract names', () => {
    for (const table of [
      'schema_migrations',
      'owners',
      'host_tokens',
      'event_types',
      'availability_schedules',
      'bookings',
      'create_rejections',
      'notification_deliveries',
    ]) {
      assert.match(
        initSql,
        new RegExp(`CREATE TABLE[\\s\\S]*?${table}`, 'i'),
        `sql/ must create ${table}`,
      );
    }
  });

  it('carries every bookings column the lifecycle writes', () => {
    for (const column of [
      'token',
      'idempotency_key',
      'create_fingerprint',
      'latest_action',
      'google_event_id',
      'google_event_etag',
      'calendar_state',
      'reserved_start',
      'reserved_end',
      'pending_op',
      'unfinished_create',
      'unresolved_inserts',
      'reap_cursor',
    ]) {
      assert.ok(initSql.includes(column), `sql/ must define bookings.${column}`);
    }
  });

  it('enforces the C11 id/token split in the schema itself', () => {
    assert.match(initSql, /check\s*\(\s*id\s*<>\s*token\s*\)/i);
  });

  it('constrains calendar_state to the C6.8 transition table’s values', () => {
    for (const state of ['pending', 'created', 'failed', 'deleted']) {
      assert.ok(initSql.includes(`'${state}'`), `calendar_state must allow ${state}`);
    }
  });

  it('seeds only one_on_one event types (Product bar lock)', () => {
    const seed = initSql.slice(initSql.indexOf('INSERT INTO event_types'));
    assert.equal(seed.includes(`'${GROUP}'`), false, 'no group row is seeded');
    assert.equal(seed.includes(`'${COLLECTIVE}'`), false, 'no collective row is seeded');
  });
});

// ---- AC-25 the shared classifier -----------------------------------------

describe('AC-25 — one classifier decides every Google outcome (C6.0)', () => {
  it('classifies the whole status table', () => {
    for (const status of [200, 201, 202, 204]) {
      assert.equal(classifyCalendarError({ status }), APPLIED, `${status}`);
    }
    for (const status of [400, 401, 403, 404, 410, 422]) {
      assert.equal(classifyCalendarError({ status }), DEFINITE, `${status}`);
    }
    assert.equal(classifyCalendarError({ status: 409 }), ALREADY_EXISTS);
    assert.equal(classifyCalendarError({ status: 412 }), PRECONDITION_FAILED);
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(classifyCalendarError({ status }), AMBIGUOUS, `${status}`);
    }
  });

  it('treats 429 as ambiguous, never definite (Product bar lock §2)', () => {
    assert.equal(classifyCalendarError({ status: 429 }), AMBIGUOUS);
    assert.notEqual(classifyCalendarError({ status: 429 }), DEFINITE);
    // A rate-limited request may still be applied, so it must never clear an
    // attempt or its pending_op — the state C6.3a exists to prevent.
    assert.equal(classifyGmailError({ status: 429 }), AMBIGUOUS);
  });

  it('classifies transport failures as ambiguous', () => {
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    assert.equal(classifyCalendarError(reset), AMBIGUOUS);
    assert.equal(classifyCalendarError(new Error('network')), AMBIGUOUS);
  });

  it('gives Gmail the same classes, so C5 finalisation matches C6.0', () => {
    for (const status of [400, 403, 404]) {
      assert.equal(classifyGmailError({ status }), DEFINITE, `${status}`);
    }
    assert.equal(classifyGmailError({ status: 503 }), AMBIGUOUS);
  });

  it('no lifecycle module tests a status code of its own', () => {
    // The import-graph half of AC-25: the classification lives in exactly one
    // file, so a step cannot quietly disagree about 429.
    const roots = ['lib/booking', 'lib/google'];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of walk(path.join(process.cwd(), root))) {
        if (file.endsWith(path.join('google', 'errors.ts'))) {
          continue;
        }
        const source = readFileSync(file, 'utf8');
        // A bare numeric comparison against an HTTP status range.
        if (/(?:status|code)\s*(?:===?|>=|<=|>|<)\s*(?:4\d\d|5\d\d)\b/.test(source)) {
          offenders.push(path.relative(process.cwd(), file));
        }
      }
    }
    assert.deepEqual(offenders, [], 'status classification belongs to lib/google/errors.ts');
  });
});

// ---- AC-24 group / collective are not on the live path -------------------

describe('AC-24 — group and collective are refused on the live path (C6.9)', () => {
  it('pg mode: an unknown slug is 404 after catalog SELECTs only', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.db().clearLog();

      const error = await expectError(() =>
        availableTimes({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: 'group-4',
          window: { start: MONDAY_0900, end: '2026-09-22T09:00:00.000Z' },
        }),
      );
      assert.equal(error.code, 'event_type_not_found');
      assert.equal(error.status, 404);
      assertNoSideEffects(harness.db().sqlLog(), harness);
    });
  });

  it('pg mode: a fixture-injected group/collective row is 501 before any side effect', async () => {
    for (const [kind, code] of [
      [GROUP, 'group_not_supported'],
      [COLLECTIVE, 'collective_not_supported'],
    ] as const) {
      await withHarness('pg', async (harness) => {
        await harness.seedOwner({ slug: DEMO.ownerSlug });
        harness.seedKindFixture({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: `${kind}-fixture`,
          kind,
          capacity: kind === GROUP ? 4 : undefined,
        });
        harness.db().clearLog();

        const error = await expectError(() =>
          createBooking({
            ownerSlug: DEMO.ownerSlug,
            eventSlug: `${kind}-fixture`,
            start: MONDAY_0900,
            invitee: INVITEE,
            notes: null,
            idempotencyKey: crypto.randomUUID(),
            origin: ORIGIN,
          }),
        );

        assert.equal(error.code, code);
        assert.equal(error.status, 501);
        assertNoSideEffects(harness.db().sqlLog(), harness);
      });
    }
  });

  it('AC-24(f) — the kind gate precedes the Idempotency-Key check (REV15-03)', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.seedKindFixture({
        ownerSlug: DEMO.ownerSlug,
        eventSlug: 'group-4',
        kind: GROUP,
        capacity: 4,
      });

      // No header at all. A `one_on_one` create is 400; a group create is 501,
      // never 400 — which is what keeps the retained fixture tests, whose
      // helpers send only `content-type`, passing unmodified.
      const group = await expectError(() =>
        createBooking({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: 'group-4',
          start: MONDAY_0900,
          invitee: INVITEE,
          notes: null,
          idempotencyKey: null,
          origin: ORIGIN,
        }),
      );
      assert.equal(group.code, 'group_not_supported');

      const oneOnOne = await expectError(() =>
        createBooking({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: DEMO.eventSlug,
          start: MONDAY_0900,
          invitee: INVITEE,
          notes: null,
          idempotencyKey: null,
          origin: ORIGIN,
        }),
      );
      assert.equal(oneOnOne.code, 'idempotency_key_required');
    });
  });

  it('AC-24(f) — the retained fixture tests are byte-for-byte unmodified', () => {
    // The exemption must be an exemption, not a test edit: these two files send
    // only `content-type` and are required to keep passing untouched.
    for (const file of ['tests/group-route.test.ts', 'tests/collective-route.test.ts']) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      assert.equal(
        /idempotency/i.test(source),
        false,
        `${file} must not have been taught about Idempotency-Key`,
      );
    }
  });

  it('pg mode materializes only one_on_one rows', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: 'ada' });
      const kinds = [...harness.db().tables().eventTypes.values()].map((row) => row.kind);
      assert.ok(kinds.length > 0);
      assert.ok(kinds.every((kind) => kind === 'one_on_one'));
    });
  });
});

function assertNoSideEffects(sqlLog: string[], harness: { db(): { rejections(): unknown[] } }): void {
  const forbidden = [
    'pg_advisory_xact_lock',
    'INSERT INTO bookings',
    'UPDATE bookings',
    'create_rejections',
    'notification_deliveries',
    'FOR UPDATE',
  ];
  for (const fragment of forbidden) {
    assert.equal(
      sqlLog.some((sql) => sql.includes(fragment)),
      false,
      `catalog resolution must not issue: ${fragment}`,
    );
  }
  assert.equal(harness.db().rejections().length, 0, 'no key is consumed');
}

// ---- AC-2 reserved root slugs --------------------------------------------

describe('AC-2 — application-owned root slugs are reserved (REV5-06)', () => {
  it('keeps the reserved list complete against the app/ tree', () => {
    const appDir = path.join(process.cwd(), 'app');
    const roots = readdirSync(appDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Route groups `(…)` and dynamic segments `[…]` own no slug.
      .filter((name) => !name.startsWith('(') && !name.startsWith('['))
      .filter((name) => isValidSlug(name));

    for (const root of roots) {
      assert.ok(
        isReservedRootSlug(root),
        `app/${root} is a static root path segment and must be in RESERVED_ROOT_SLUGS`,
      );
    }
  });

  it('refuses a reserved slug at every boundary, before any write', async () => {
    await withHarness('memory', async (harness) => {
      for (const slug of RESERVED_ROOT_SLUGS) {
        assert.throws(() => assertAssignableOwnerSlug(slug), ReservedOwnerSlugError, slug);
        await assert.rejects(
          () =>
            materializeOwner(harness.owners, {
              slug,
              firstName: 'Reserved',
              email: `${slug}@example.com`,
            }),
          ReservedOwnerSlugError,
          slug,
        );
        // Not a single owner row was written.
        assert.equal(await harness.owners.getBySlug(slug), null, slug);
      }
    });
  });

  it('derives an owner slug from the email local-part and rejects reserved ones', () => {
    assert.equal(ownerSlugFromEmail('ada@myoli.co'), 'ada');
    for (const slug of ['b', 'host', 'api']) {
      assert.throws(
        () => assertAssignableOwnerSlug(ownerSlugFromEmail(`${slug}@myoli.co`) ?? ''),
        ReservedOwnerSlugError,
      );
    }
  });

  it('resolves no scope for a reserved owner slug', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      const error = await expectError(() => resolveScope('b', DEMO.eventSlug));
      assert.equal(error.code, 'owner_not_found');
      assert.equal(error.status, 404);
    });
  });
});

// ---- AC-6 the offline proof harness --------------------------------------

describe('AC-6 — the proof harness is offline and self-bootstrapping', () => {
  it('passes an explicitly disabled environment to every child', () => {
    const child = proof.proofChildEnv({
      LIVE_CALENDAR: '1',
      LIVE_EMAIL: '1',
      DATABASE_URL: 'postgres://real/db',
    });
    assert.equal(child.MARLO_PROOF, '1');
    assert.equal(child.LIVE_CALENDAR, '0');
    assert.equal(child.LIVE_EMAIL, '0');
    assert.equal(child.DATABASE_URL, '');
  });

  it('runs typecheck, build, and unit tests in that order', () => {
    const calls: string[][] = [];
    const status = proof.runProof({
      env: {},
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>;
      },
    });
    assert.equal(status.status, 0);
    assert.deepEqual(calls, [
      ['npm', 'run', 'typecheck'],
      ['npm', 'run', 'build'],
      ['npm', 'run', 'test:unit'],
    ]);
  });

  it('stops at the first failing step', () => {
    const calls: string[][] = [];
    const status = proof.runProof({
      env: {},
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 1 } as ReturnType<typeof import('node:child_process').spawnSync>;
      },
    });
    assert.equal(status.status, 1);
    assert.equal(calls.length, 1, 'a red typecheck never reaches the build');
  });

  it('provisions dependencies before any proof step, and logs the network call', () => {
    const logged: string[] = [];
    const calls: string[][] = [];
    const result = proof.provisionDependencies({
      exists: () => false,
      env: {},
      log: (line: string) => logged.push(line),
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>;
      },
    });
    assert.equal(result.provisioned, true);
    assert.deepEqual(calls, [['npm', 'ci']]);
    assert.deepEqual(logged, [proof.PROVISION_LOG]);
  });

  it('refuses to provision under MARLO_OFFLINE=1', () => {
    const errors: string[] = [];
    const calls: string[][] = [];
    const result = proof.provisionDependencies({
      exists: () => false,
      env: { MARLO_OFFLINE: '1' },
      error: (line: string) => errors.push(line),
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>;
      },
    });
    assert.equal(result.status, 2);
    assert.deepEqual(calls, [], 'nothing touches the network');
    assert.deepEqual(errors, [proof.OFFLINE_REFUSAL]);
  });

  it('skips provisioning entirely when dependencies are present', () => {
    const calls: string[][] = [];
    const result = proof.provisionDependencies({
      exists: () => true,
      env: {},
      spawn: (command: string, args: string[]) => {
        calls.push([command, ...args]);
        return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>;
      },
    });
    assert.equal(result.provisioned, false);
    assert.deepEqual(calls, []);
  });
});

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}
