// Runtime composition. One place decides which implementations a request runs
// against, from `lib/env` alone:
//
//   memory mode → `MemoryBookingStore`, `MemoryOwnerStore`, the mock calendar
//                 and mock sender. There are no live adapters in memory mode
//                 (AC-6), which is why `npm test` cannot reach the network.
//   pg mode     → `PgBookingStore` over the injected `Queryable`, plus the live
//                 Google adapters when `LIVE_CALENDAR` / `LIVE_EMAIL` are set.

import { systemClock, type Clock } from '../clock';
import { getDatabase, hasDatabase } from '../db/index';
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
import { MemoryOwnerStore, type OwnerStore } from '../owners';
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
  const base = env.store === 'pg' && hasDatabase() ? pgRuntime(env) : memoryModeRuntime(env);
  if (override === null) {
    return base;
  }
  return {
    ...base,
    ...(override.store === undefined ? {} : { store: override.store }),
    ...(override.owners === undefined ? {} : { owners: override.owners }),
    ...(override.calendar === undefined ? {} : { calendar: override.calendar }),
    ...(override.sender === undefined ? {} : { sender: override.sender }),
    ...(override.clock === undefined ? {} : { clock: override.clock }),
    ...(override.from === undefined ? {} : { from: override.from }),
    env,
  };
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
  const accessToken = async (): Promise<string> => {
    // The refresh token lives encrypted in `host_tokens` (AC-14). Without a
    // key or a stored token this is `host_not_connected` — a DEFINITE failure
    // by C6.0, reported as `delivery.*: failed`, never a crash.
    throw new HostNotConnectedError();
  };
  const fetchImpl = injectedFetch;
  return {
    env,
    store,
    owners,
    calendar:
      env.calendar === 'live' && fetchImpl !== null
        ? createLiveCalendar({ fetch: fetchImpl, accessToken })
        : createMockCalendar(),
    sender:
      env.email === 'live' && fetchImpl !== null
        ? createLiveEmailSender({ fetch: fetchImpl, accessToken })
        : createMockEmailSender(),
    clock: systemClock,
    from: 'marlo@example.com',
  };
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
