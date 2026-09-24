// Owner-scoped identity (C1 / REV1-01, REV1-02, REV5-06).
//
// Every event type belongs to exactly one owner, and every durable identifier
// is a deterministic function of slugs (C1) so a fresh serverless isolate that
// re-seeds fixtures reproduces the same ids and a persisted booking's
// `eventTypeId` / `scheduleId` always resolves.
//
// Reserved root slugs (REV5-06): an owner slug that collides with an
// application-owned root path segment (`/b/{token}`, the middleware-protected
// `/host`, …) is refused at **every** boundary — sign-in, both stores,
// `resolveOwner`, and public-path construction — never silently suffixed.

export const OWNER_SLUG_RESERVED = 'owner_slug_reserved' as const;
export const OWNER_SLUG_TAKEN = 'owner_slug_taken' as const;

/**
 * Application-owned root path segments. Kept complete by
 * `tests/reserved-slugs.test.ts`, which derives the set from the `app/` tree:
 * every non-dynamic directory that contributes a first URL segment (route
 * groups `(…)` are transparent and are recursed into) must appear here.
 */
export const RESERVED_ROOT_SLUGS = [
  'api',
  'b',
  'components',
  'host',
  'signin',
  'tokens',
] as const;

const RESERVED = new Set<string>(RESERVED_ROOT_SLUGS);

/** AC-2: 1–64 chars, lower-case alphanumeric with interior hyphens. */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export type Owner = {
  id: string;
  slug: string;
  firstName: string;
  email: string;
  calendarId: string;
};

export type StableIds = {
  ownerId: string;
  eventTypeId: string;
  scheduleId: string;
};

export class ReservedOwnerSlugError extends Error {
  readonly status = 400;
  readonly code = OWNER_SLUG_RESERVED;
  constructor(slug: string) {
    super(`${OWNER_SLUG_RESERVED}: ${slug}`);
    this.name = 'ReservedOwnerSlugError';
  }
}

export class OwnerSlugTakenError extends Error {
  readonly status = 409;
  readonly code = OWNER_SLUG_TAKEN;
  constructor(slug: string) {
    super(`${OWNER_SLUG_TAKEN}: ${slug}`);
    this.name = 'OwnerSlugTakenError';
  }
}

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

export function isReservedRootSlug(slug: string): boolean {
  return RESERVED.has(normalizeSlug(slug));
}

/** Lower-cases and trims; lookups are always normalized before they hit SQL. */
export function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function ownerIdForSlug(ownerSlug: string): string {
  return `own_${normalizeSlug(ownerSlug)}`;
}

export function eventTypeIdFor(ownerSlug: string, eventSlug: string): string {
  return `evt_${normalizeSlug(ownerSlug)}__${normalizeSlug(eventSlug)}`;
}

export function scheduleIdFor(ownerSlug: string, scheduleKey: string): string {
  return `sch_${normalizeSlug(ownerSlug)}__${normalizeSlug(scheduleKey)}`;
}

export function stableIds(
  ownerSlug: string,
  eventSlug: string,
  scheduleKey = 'default',
): StableIds {
  return {
    ownerId: ownerIdForSlug(ownerSlug),
    eventTypeId: eventTypeIdFor(ownerSlug, eventSlug),
    scheduleId: scheduleIdFor(ownerSlug, scheduleKey),
  };
}

/**
 * The owner slug is the validated local-part of the host's Google address
 * (Assumptions). A reserved local-part fails sign-in with
 * `owner_slug_reserved` before any `owners` / `host_tokens` write.
 */
export function ownerSlugFromEmail(email: string): string | null {
  const at = email.indexOf('@');
  if (at <= 0) {
    return null;
  }
  const local = normalizeSlug(email.slice(0, at));
  return isValidSlug(local) ? local : null;
}

export function assertAssignableOwnerSlug(slug: string): string {
  const normalized = normalizeSlug(slug);
  if (!isValidSlug(normalized)) {
    throw new ReservedOwnerSlugError(slug);
  }
  if (isReservedRootSlug(normalized)) {
    throw new ReservedOwnerSlugError(normalized);
  }
  return normalized;
}

// ---- store ---------------------------------------------------------------

export type HostToken = {
  ownerId: string;
  /** AES-256-GCM ciphertext of the refresh token (AC-14). */
  refreshTokenEnc: Uint8Array;
  updatedAt: string;
};

/** C1 — the schedule materialization writes, under its deterministic id. */
export type ScheduleRecord = {
  id: string;
  ownerId: string;
  timezone: string;
  windows: { weekday: number; start: string; end: string }[];
};

/** C1 — an event type materialization writes. Only `one_on_one` is ever written. */
export type EventTypeRecord = {
  id: string;
  ownerId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  scheduleId: string;
  notificationMode: string;
};

export interface OwnerStore {
  upsert(owner: Owner): Promise<Owner>;
  getBySlug(slug: string): Promise<Owner | null>;
  getById(id: string): Promise<Owner | null>;
  putHostToken(token: HostToken): Promise<void>;
  getHostToken(ownerId: string): Promise<HostToken | null>;
  /**
   * C1 — sign-in materialization persists the owner's schedule and event types
   * **through the same store the catalog reads**. Writing them only to
   * process-local maps is what would leave a freshly signed-in owner's
   * `intro-30` unresolvable in pg mode, where the catalog reads SQL.
   */
  upsertSchedule(schedule: ScheduleRecord): Promise<void>;
  upsertEventType(eventType: EventTypeRecord): Promise<void>;
}

export class MemoryOwnerStore implements OwnerStore {
  private readonly bySlug = new Map<string, Owner>();
  private readonly byId = new Map<string, Owner>();
  private readonly tokens = new Map<string, HostToken>();

  async upsert(owner: Owner): Promise<Owner> {
    const slug = assertAssignableOwnerSlug(owner.slug);
    const stored: Owner = { ...owner, slug, id: owner.id || ownerIdForSlug(slug) };
    const existing = this.bySlug.get(slug);
    if (existing && existing.id !== stored.id) {
      throw new OwnerSlugTakenError(slug);
    }
    this.bySlug.set(slug, stored);
    this.byId.set(stored.id, stored);
    return { ...stored };
  }

  async getBySlug(slug: string): Promise<Owner | null> {
    const found = this.bySlug.get(normalizeSlug(slug));
    return found ? { ...found } : null;
  }

  async getById(id: string): Promise<Owner | null> {
    const found = this.byId.get(id);
    return found ? { ...found } : null;
  }

  async putHostToken(token: HostToken): Promise<void> {
    this.tokens.set(token.ownerId, {
      ...token,
      refreshTokenEnc: new Uint8Array(token.refreshTokenEnc),
    });
  }

  async getHostToken(ownerId: string): Promise<HostToken | null> {
    const found = this.tokens.get(ownerId);
    return found
      ? { ...found, refreshTokenEnc: new Uint8Array(found.refreshTokenEnc) }
      : null;
  }

  /**
   * Memory mode's catalog **is** the in-process fixture registry that
   * `materializeOwner` already writes through `createAvailabilitySchedule` /
   * `createEventType`, so there is nothing further to persist here.
   */
  async upsertSchedule(): Promise<void> {}

  async upsertEventType(): Promise<void> {}

  reset(): void {
    this.bySlug.clear();
    this.byId.clear();
    this.tokens.clear();
  }
}
