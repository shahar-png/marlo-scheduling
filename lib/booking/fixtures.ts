// Fixture seeding for the durable path (C1).
//
// The in-memory store, like the seeded Postgres catalog, must never be empty in
// production: `/demo/intro-30` is always bookable. Seeding is idempotent and
// materializes only `kind='one_on_one'` rows (Product bar lock).

import { ensureDemoOwner, materializeOwner, DEMO_OWNER_SLUG } from '../owners-materialize';
import { isReservedRootSlug, isValidSlug, normalizeSlug } from '../owners';
import { getRuntime } from './runtime';

/**
 * Seeds the demo owner, and — in memory mode only — an owner for any other
 * requested slug so the fixture-backed pages work without a sign-in. In pg mode
 * owners exist only through the migration seed and sign-in materialization, so
 * an unknown slug stays a 404 (AC-1).
 */
export async function ensureOwnerFixtures(ownerSlug: string): Promise<void> {
  const runtime = getRuntime();
  const slug = normalizeSlug(ownerSlug);
  if (!isValidSlug(slug) || isReservedRootSlug(slug)) {
    return;
  }
  if ((await runtime.owners.getBySlug(DEMO_OWNER_SLUG)) === null) {
    await ensureDemoOwner(runtime.owners);
  }
  if (slug === DEMO_OWNER_SLUG || runtime.env.store === 'pg') {
    return;
  }
  if ((await runtime.owners.getBySlug(slug)) === null) {
    await materializeOwner(runtime.owners, {
      slug,
      firstName: titleCase(slug),
      email: `${slug}@example.com`,
    });
  }
}

export async function ensureDemoFixturesDurable(): Promise<void> {
  const runtime = getRuntime();
  if ((await runtime.owners.getBySlug(DEMO_OWNER_SLUG)) === null) {
    await ensureDemoOwner(runtime.owners);
  }
}

function titleCase(slug: string): string {
  const first = slug.slice(0, 1).toUpperCase();
  return `${first}${slug.slice(1)}`;
}
