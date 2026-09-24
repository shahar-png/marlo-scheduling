import { ensureDatabase } from '@/lib/db/index';
import { healthOk, healthSchema, type DbState, type SchemaState } from '@/lib/db/health';
import { resolveEnv } from '@/lib/env';

// C13 — `/api/health`.
//
// Pg mode issues **exactly one** bounded `schema_migrations` readiness query per
// request and derives `schema` from its result alone: no cached observation, no
// `assertMigrated()`, nothing memoised, so the first request a fresh isolate
// serves and the thousandth compute it the same way (REV9-03). Memory mode does
// **zero I/O**. No Google, Gmail, or other `fetch` of any kind.
//
// `ok` is true iff `schema ∈ {current, n/a}`, and the HTTP status follows it, so
// an unmigrated or unreachable database fails a post-deploy check loudly instead
// of reporting a green deploy the store would then refuse to serve.
//
// This route is the single exception on the "no env read outside lib/env" grep
// list, and only for the deploy SHA names below.

export const dynamic = 'force-dynamic';

function deploySha(): string {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.VERCEL_DEPLOYMENT_ID ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    ''
  );
}

export async function GET() {
  const env = resolveEnv();
  let schema: SchemaState = 'n/a';
  let db: DbState = 'n/a';

  if (env.store === 'pg') {
    // `DATABASE_URL` selected pg, so readiness is never skipped. A database
    // that cannot even be initialized is `unreachable` / `unknown` → 503,
    // rather than a green deploy the store would then refuse to serve.
    try {
      const readiness = await healthSchema(ensureDatabase());
      schema = readiness.schema;
      db = readiness.db;
    } catch {
      schema = 'unknown';
      db = 'unreachable';
    }
  }

  const ok = healthOk(schema);
  return Response.json(
    {
      ok,
      sha: deploySha(),
      store: env.store,
      schema,
      db,
      // Configuration, never connectivity.
      calendar: env.calendar,
      email: env.email,
    },
    { status: ok ? 200 : 503 },
  );
}
