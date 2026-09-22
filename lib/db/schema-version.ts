// Single source of truth for the applied schema version (C8). Shared by
// `scripts/migrate.cjs`, the pg store's serving guard, and `/api/health`, so
// nothing reads `sql/` at runtime. `tests/schema.test.ts` asserts this equals
// the highest `sql/*.sql` version in the tree.

export const LATEST_SCHEMA_VERSION = 1;
