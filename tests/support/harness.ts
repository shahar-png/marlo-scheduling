// One harness both store modes run through, so every C6 rule is proved twice
// from the same script (AC-3: "the memory store runs the same matrix").
//
// `withHarness('memory' | 'pg', fn)` hands the test a live `Runtime` wired into
// `getRuntime()`, a fake clock, the mock calendar, the mock sender, and — in pg
// mode — the recording `Queryable` whose statement log the AC-24 / AC-15 / AC-3
// assertions read. Nothing here touches the network: importing this module arms
// the AC-6 fetch guard.

import './fetch-guard';

import { createFakeClock, type FakeClock } from '../../lib/clock';
import { setDatabase } from '../../lib/db/index';
import {
  resetEventTypes,
  type EventTypeKind,
} from '../../lib/availability/event-type';
import { resetAvailabilitySchedules } from '../../lib/availability/schedule';
import {
  createMockCalendar,
  type CollisionMode,
  type MockCalendar,
} from '../../lib/google/mock-calendar';
import { createLiveCalendar } from '../../lib/google/live-calendar';
import type { CalendarClient } from '../../lib/google/calendar';
import {
  createLiveEmailSender,
  createMockEmailSender,
  type BookingEmailSender,
  type MockEmailSender,
} from '../../lib/email/sender';
import { createGoogleFetch, type GoogleFetch } from './google-fetch';
import { MemoryBookingStore } from '../../lib/booking/memory-store';
import { PgBookingStore } from '../../lib/booking/pg-store';
import { MemoryOwnerStore, ownerIdForSlug, type OwnerStore } from '../../lib/owners';
import { PgOwnerStore } from '../../lib/owners-pg';
import {
  DEFAULT_SCHEDULE_KEY,
  DEMO_EVENT_SLUG,
  DEMO_OWNER_SLUG,
  materializeOwner,
} from '../../lib/owners-materialize';
import { eventTypeIdFor, scheduleIdFor } from '../../lib/owners';
import { resetRuntime, setRuntimeOverride, type Runtime } from '../../lib/booking/runtime';
import { setEnvOverride } from '../../lib/env';
import type { BookingStore } from '../../lib/booking/store';
import { createFakeDatabase, type FakeDatabase } from './pg-fake';

export type StoreMode = 'memory' | 'pg';

/**
 * Which Google adapters the runtime is wired to (AC-12 parity, AC-25(g)).
 *
 *   `mock`  the in-memory adapter — the memory-mode production path;
 *   `live`  `createLiveCalendar` / `createLiveEmailSender` over a fake `fetch`
 *           that speaks Google's REST shape against the **same** model, so a
 *           scenario run under both compares adapters, not two doubles.
 */
export type AdapterMode = 'mock' | 'live';

export type Harness = {
  mode: StoreMode;
  adapters: AdapterMode;
  runtime: Runtime;
  store: BookingStore;
  owners: OwnerStore;
  /**
   * The calendar **model** — seeding, collision mode, held inserts, and every
   * `liveEvents()` assertion go through it in both adapter modes. The adapter
   * actually under test is `runtime.calendar`.
   */
  calendar: MockCalendar;
  sender: MockEmailSender;
  /** Gmail sends in `live` adapter mode; `null` under `mock`. */
  googleFetch: GoogleFetch | null;
  clock: FakeClock;
  /** Only in pg mode; throws in memory mode. */
  db(): FakeDatabase;
  /** Materializes an owner plus its fixture catalog in whichever mode is active. */
  seedOwner(input: {
    slug: string;
    firstName?: string;
    email?: string;
    calendarId?: string;
  }): Promise<{ ownerId: string; hostId: string; eventTypeId: string }>;
  /** Plants a catalog row of a kind the live path refuses (AC-24(c)). */
  seedKindFixture(input: {
    ownerSlug: string;
    eventSlug: string;
    kind: EventTypeKind;
    capacity?: number;
  }): void;
  /** Drops a fresh isolate on the same durable state (AC-3 fresh-isolate). */
  freshIsolate(): Harness;
};

const WEEKDAYS = [1, 2, 3, 4, 5];

export const DEMO = {
  ownerSlug: DEMO_OWNER_SLUG,
  eventSlug: DEMO_EVENT_SLUG,
  ownerId: ownerIdForSlug(DEMO_OWNER_SLUG),
  eventTypeId: eventTypeIdFor(DEMO_OWNER_SLUG, DEMO_EVENT_SLUG),
  scheduleId: scheduleIdFor(DEMO_OWNER_SLUG, DEFAULT_SCHEDULE_KEY),
} as const;

/** A Monday 09:00 UTC inside the fixture schedule. */
export const MONDAY_0900 = '2026-09-21T09:00:00.000Z';

export function isoAt(minutesFrom0900: number): string {
  return new Date(Date.parse(MONDAY_0900) + minutesFrom0900 * 60_000).toISOString();
}

export async function withHarness<T>(
  mode: StoreMode,
  fn: (harness: Harness) => Promise<T>,
  options: HarnessOptions = {},
): Promise<T> {
  const harness = createHarness(mode, options);
  try {
    return await fn(harness);
  } finally {
    teardown();
  }
}

/** Runs the same script against both stores — the default for every C6 proof. */
export async function bothStores(
  fn: (harness: Harness) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  for (const mode of ['memory', 'pg'] as const) {
    await withHarness(mode, fn, options);
  }
}

/**
 * AC-12 parity / AC-25(g) — runs the same script against the mock adapters and
 * against the **live** adapters over the fake Google transport. Any observable
 * difference is a difference between the two adapters.
 */
export async function bothAdapters(
  mode: StoreMode,
  fn: (harness: Harness) => Promise<void>,
): Promise<void> {
  for (const adapters of ['mock', 'live'] as const) {
    await withHarness(mode, fn, { adapters });
  }
}

/**
 * AC-12 / C6.3a — runs the same script under **both** documented Google
 * behaviours for a re-used id: 409 `duplicate`, and a late insert that lands.
 */
export async function bothCollisionModes(
  fn: (harness: Harness, collisionMode: CollisionMode) => Promise<void>,
  options: HarnessOptions = {},
): Promise<void> {
  for (const collisionMode of ['duplicate', 'land'] as const) {
    await withHarness('memory', (harness) => fn(harness, collisionMode), {
      ...options,
      collisionMode,
    });
  }
}

export type HarnessOptions = {
  adapters?: AdapterMode;
  collisionMode?: CollisionMode;
};

export function createHarness(mode: StoreMode, options: HarnessOptions = {}): Harness {
  resetRuntime();
  resetEventTypes();
  resetAvailabilitySchedules();

  const adapters = options.adapters ?? 'mock';
  const clock = createFakeClock(Date.parse(MONDAY_0900));
  const calendar = createMockCalendar(
    options.collisionMode === undefined ? {} : { collisionMode: options.collisionMode },
  );
  const sender = createMockEmailSender();
  // In `live` mode the model above is reached only through Google's REST shape,
  // so the adapter under test is the production one (AC-12 parity, AC-25(g)).
  const googleFetch = adapters === 'live' ? createGoogleFetch(calendar) : null;
  const accessToken = async () => 'harness-access-token';
  const calendarAdapter: CalendarClient =
    googleFetch === null
      ? calendar
      : createLiveCalendar({ fetch: googleFetch, accessToken });
  const senderAdapter: BookingEmailSender =
    googleFetch === null
      ? sender
      : createLiveEmailSender({ fetch: googleFetch, accessToken });

  let fake: FakeDatabase | null = null;
  let store: BookingStore;
  let owners: OwnerStore;

  if (mode === 'pg') {
    fake = createFakeDatabase();
    setDatabase(fake);
    setEnvOverride({ DATABASE_URL: 'postgres://fake/marlo' });
    store = new PgBookingStore(fake);
    owners = new PgOwnerStore(fake);
  } else {
    setDatabase(null);
    setEnvOverride({});
    store = new MemoryBookingStore();
    owners = new MemoryOwnerStore();
  }

  const runtime: Runtime = {
    env: {
      store: mode,
      calendar: adapters,
      email: adapters,
      databaseUrl: mode === 'pg' ? 'postgres://fake/marlo' : null,
      oauthTokenKey: null,
      googleClientId: null,
      googleClientSecret: null,
      proof: false,
      offline: false,
    },
    store,
    owners,
    calendar: calendarAdapter,
    sender: senderAdapter,
    clock,
    from: 'marlo@example.com',
  };
  setRuntimeOverride(runtime);

  return buildHarness(mode, adapters, runtime, calendar, sender, googleFetch, clock, fake);
}

function buildHarness(
  mode: StoreMode,
  adapters: AdapterMode,
  runtime: Runtime,
  calendar: MockCalendar,
  sender: MockEmailSender,
  googleFetch: GoogleFetch | null,
  clock: FakeClock,
  fake: FakeDatabase | null,
): Harness {
  const harness: Harness = {
    mode,
    adapters,
    runtime,
    store: runtime.store,
    owners: runtime.owners,
    calendar,
    sender,
    googleFetch,
    clock,
    db() {
      if (fake === null) {
        throw new Error('harness: db() is pg-mode only');
      }
      return fake;
    },
    async seedOwner(input) {
      const { owner, eventTypes } = await materializeOwner(runtime.owners, {
        slug: input.slug,
        firstName: input.firstName ?? titleCase(input.slug),
        email: input.email ?? `${input.slug}@example.com`,
        ...(input.calendarId === undefined ? {} : { calendarId: input.calendarId }),
      });
      // No supplemental seeding: `materializeOwner` is the production sign-in
      // path and writes the owner, the schedule, and the `one_on_one` event
      // types through the store the catalog reads (C1). Seeding them here would
      // mask a materialization that never persisted them.
      const first = eventTypes[0];
      return { ownerId: owner.id, hostId: owner.id, eventTypeId: first.id };
    },
    seedKindFixture(input) {
      // Bypasses seed and materialization on purpose: in pg mode no such row
      // can be produced by the product, so AC-24's 501 branch is reachable only
      // through a fixture-injected catalog row.
      const ownerId = ownerIdForSlug(input.ownerSlug);
      if (fake === null) {
        throw new Error('harness: seedKindFixture is pg-mode only');
      }
      fake.seedEventType({
        id: eventTypeIdFor(input.ownerSlug, input.eventSlug),
        owner_id: ownerId,
        slug: input.eventSlug,
        kind: input.kind,
        duration_min: 30,
        capacity: input.capacity ?? null,
        notification_mode: 'email_confirmation',
        schedule_id: scheduleIdFor(input.ownerSlug, DEFAULT_SCHEDULE_KEY),
        name: `${input.eventSlug} fixture`,
      });
    },
    freshIsolate() {
      // A new module instance over the SAME durable state: the pg fake keeps
      // its tables, the stores and caches are rebuilt. In memory mode the store
      // instance is the state, so it is carried over deliberately.
      const nextStore: BookingStore =
        fake === null ? runtime.store : new PgBookingStore(fake);
      const nextOwners: OwnerStore =
        fake === null ? runtime.owners : new PgOwnerStore(fake);
      const nextCalendar = calendar;
      const next: Runtime = {
        ...runtime,
        store: nextStore,
        owners: nextOwners,
      };
      setRuntimeOverride(next);
      return buildHarness(
        mode,
        adapters,
        next,
        nextCalendar,
        sender,
        googleFetch,
        clock,
        fake,
      );
    },
  };
  return harness;
}

export function teardown(): void {
  setRuntimeOverride(null);
  resetRuntime();
  setDatabase(null);
  setEnvOverride(null);
  resetEventTypes();
  resetAvailabilitySchedules();
}

function titleCase(slug: string): string {
  return `${slug.slice(0, 1).toUpperCase()}${slug.slice(1)}`;
}

/** Advances the fake clock past the 2-minute operation stale window (C6.3). */
export async function advancePastStaleWindow(clock: FakeClock): Promise<void> {
  await clock.advance(121_000);
}
