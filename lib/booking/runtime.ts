// Runtime composition. One place decides which implementations a request runs
// against, from `lib/env` alone:
//
//   memory mode → `MemoryBookingStore`, `MemoryOwnerStore`, the mock calendar
//                 and mock sender. There are no live adapters in memory mode
//                 (AC-6), which is why `npm test` cannot reach the network.
//   pg mode     → `PgBookingStore` over the injected `Queryable`, plus the live
//                 Google adapters when `LIVE_CALENDAR` / `LIVE_EMAIL` are set.

import { systemClock, type Clock } from '../clock';
import { ensureDatabase, getDatabase } from '../db/index';
import { resolveEnv, type ResolvedEnv } from '../env';
import { createLiveCalendar, type FetchLike } from '../google/live-calendar';
import { createMockCalendar, type MockCalendar } from '../google/mock-calendar';
import { HostNotConnectedError } from '../google/errors';
import { decryptRefreshToken, exchangeRefreshToken } from '../google/oauth';
import type { CalendarClient } from '../google/calendar';
import {
  createLiveEmailSender,
  createMockEmailSender,
  type BookingEmailSender,
  type MockEmailSender,
} from '../email/sender';
import { MemoryOwnerStore, type Owner, type OwnerStore } from '../owners';
import { DEMO_OWNER_SLUG } from '../owners-materialize';
import { PgOwnerStore } from '../owners-pg';
import { MemoryBookingStore } from './memory-store';
import { PgBookingStore } from './pg-store';
import type { BookingStore } from './store';

export type Runtime = {
  env: ResolvedEnv;
  store: BookingStore;
  owners: OwnerStore;
  calendar: CalendarClient;
  sender: BookingEmailSender;
  clock: Clock;
  /** Sender identity for outbound mail; the owner's address in live mode. */
  from: string;
  /**
   * Binds the Google adapters to a specific owner — their OAuth token and their
   * mailbox. Present only in pg mode; memory mode and every test double use the
   * shared `calendar` / `sender` above.
   */
  adaptersFor?: (owner: Owner) => {
    calendar: CalendarClient;
    sender: BookingEmailSender;
    from: string;
  };
};

export type RuntimeOverride = Partial<Runtime> & {
  /** Convenience for tests that want the mock doubles back. */
  mockCalendar?: MockCalendar;
  mockSender?: MockEmailSender;
};

let override: RuntimeOverride | null = null;
let memoryRuntime: Runtime | null = null;
let injectedFetch: FetchLike | null = null;

export function setRuntimeOverride(next: RuntimeOverride | null): void {
  override = next;
}

/** Live adapters take their `fetch` from here so tests can supply a fake. */
export function setGoogleFetch(next: FetchLike | null): void {
  injectedFetch = next;
}

export function resetRuntime(): void {
  override = null;
  memoryRuntime = null;
}

export function getRuntime(): Runtime {
  const env = override?.env ?? resolveEnv();
  const base = baseRuntime(env);
  if (override === null) {
    return base;
  }
  // An explicit adapter override is a test double; it replaces the per-owner
  // live factory rather than sitting beside it.
  const overridesAdapters =
    override.calendar !== undefined || override.sender !== undefined;
  return {
    ...base,
    ...(overridesAdapters ? { adaptersFor: undefined } : {}),
    ...(override.store === undefined ? {} : { store: override.store }),
    ...(override.owners === undefined ? {} : { owners: override.owners }),
    ...(override.calendar === undefined ? {} : { calendar: override.calendar }),
    ...(override.sender === undefined ? {} : { sender: override.sender }),
    ...(override.clock === undefined ? {} : { clock: override.clock }),
    ...(override.from === undefined ? {} : { from: override.from }),
    env,
  };
}

/**
 * `DATABASE_URL` selects `pg`, and pg mode **never** falls back to memory: a
 * per-isolate map would accept bookings that vanish on the next request and
 * would make `/api/health` report a green deploy the store cannot serve. An
 * initialization failure propagates as `store_driver_unavailable` (503).
 */
function baseRuntime(env: ResolvedEnv): Runtime {
  if (env.store !== 'pg') {
    return memoryModeRuntime(env);
  }
  // Throws `DatabaseUnavailableError` when no driver or connection string is
  // reachable; routes map it to 503 and health reports `db: "unreachable"`.
  ensureDatabase();
  return pgRuntime(env);
}

/** The shared memory-mode runtime — one per process, like the fixtures. */
function memoryModeRuntime(env: ResolvedEnv): Runtime {
  if (memoryRuntime === null) {
    memoryRuntime = {
      env,
      store: new MemoryBookingStore(),
      owners: new MemoryOwnerStore(),
      calendar: createMockCalendar(),
      sender: createMockEmailSender(),
      clock: systemClock,
      from: 'marlo@example.com',
    };
  }
  return { ...memoryRuntime, env };
}

export function memoryRuntimeHandle(): Runtime {
  return memoryModeRuntime(resolveEnv());
}

function pgRuntime(env: ResolvedEnv): Runtime {
  const db = getDatabase();
  const store = new PgBookingStore(db);
  const owners = new PgOwnerStore(db);
  // Production uses the platform `fetch`; a test may pin a fake one.
  const fetchImpl: FetchLike = injectedFetch ?? ((input, init) => fetch(input, init));
  // C2/P1 — `/demo/intro-30` is the **fixture-backed** demo route, never the
  // product URL. The `demo` owner is written by the migration seed and has no
  // `host_tokens` row, so binding it to the live adapters made its availability
  // fail closed with `availability_unknown` the moment `LIVE_CALENDAR=1` was set
  // (REV-06). One pair per runtime, so a demo booking's event survives between
  // requests in the isolate the way a fixture should.
  const demoCalendar = createMockCalendar();
  const demoSender = createMockEmailSender();

  return {
    env,
    store,
    owners,
    // The zero-owner defaults. Every lifecycle call goes through `adaptersFor`,
    // which binds the adapters to the owner whose token and mailbox they use.
    calendar: createMockCalendar(),
    sender: createMockEmailSender(),
    clock: systemClock,
    from: 'marlo@example.com',
    adaptersFor(owner) {
      if (isDemoOwner(owner)) {
        // The demo owner never reaches Google or Gmail, in any mode. Every
        // lifecycle call — create, availability, and the `/b/{token}` reads —
        // binds its adapters here, so the isolation is consistent by
        // construction rather than repeated per route.
        return { calendar: demoCalendar, sender: demoSender, from: owner.email };
      }
      // AC-14: the host's refresh token lives encrypted in `host_tokens`, is
      // exchanged for an access token per request, and a missing or revoked one
      // is `host_not_connected` — a DEFINITE failure by C6.0, reported as
      // `delivery.*: failed`, never a crash.
      const accessToken = () => hostAccessToken(owners, owner.id, fetchImpl, env);
      return {
        calendar:
          env.calendar === 'live'
            ? createLiveCalendar({ fetch: fetchImpl, accessToken })
            : createMockCalendar(),
        sender:
          env.email === 'live'
            ? createLiveEmailSender({ fetch: fetchImpl, accessToken })
            : createMockEmailSender(),
        // Marlo sends **as the host**, so the sender identity is the owner's.
        from: owner.email,
      };
    },
  };
}

/** The seeded fixture owner behind `/demo/…` — never a live host (C2/P1). */
export function isDemoOwner(owner: Pick<Owner, 'slug'>): boolean {
  return owner.slug === DEMO_OWNER_SLUG;
}

/**
 * Resolves a host's Google access token from the encrypted refresh token
 * (AC-14). Exported for the live adapters and the Founder smoke path.
 */
export async function hostAccessToken(
  owners: OwnerStore,
  ownerId: string,
  fetchImpl: FetchLike,
  env: ResolvedEnv,
): Promise<string> {
  const stored = await owners.getHostToken(ownerId);
  if (stored === null || env.oauthTokenKey === null) {
    throw new HostNotConnectedError();
  }
  const refreshToken = decryptRefreshToken(stored.refreshTokenEnc, env.oauthTokenKey);
  const token = await exchangeRefreshToken({
    fetch: fetchImpl,
    refreshToken,
    clientId: env.googleClientId,
    clientSecret: env.googleClientSecret,
  });
  return token.accessToken;
}
