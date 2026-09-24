// Read-only catalog resolution, and the C6.9 kind gate.
//
// REV10-03: catalog resolution is **distinguished from booking side effects**.
// Resolving the owner, event type, and schedule is a catalog *read* — it is
// permitted and unavoidable on the production path — and the 501 refusal for a
// `group` / `collective` kind fires immediately after it and **before** any
// advisory lock, `bookings` / `create_rejections` / `notification_deliveries`
// write, `FOR UPDATE` read, L0/R0, `freeBusy`, `events.list`, calendar
// mutation, or email.
//
// In pg/live mode no such row can exist (the seed and sign-in materialization
// write `kind='one_on_one'` only), so the production answer for such a slug is
// the ordinary 404 `event_type_not_found`; the 501 branch is reached only
// through a fixture-injected catalog row, which AC-24 exercises explicitly.

import {
  COLLECTIVE,
  GROUP,
  getEventType,
  resolveEventType,
  type EventType,
  type EventTypeKind,
} from './availability/event-type';
import { getAvailabilitySchedule, type AvailabilitySchedule } from './availability/schedule';
import {
  CollectiveNotSupportedError,
  EventTypeNotFoundError,
  GroupNotSupportedError,
  OwnerNotFoundError,
} from './booking/errors';
import type { Queryable } from './db/index';
import { isReservedRootSlug, isValidSlug, normalizeSlug, type Owner } from './owners';

export type ResolvedCatalog = {
  owner: Owner;
  eventType: EventType;
  schedule: AvailabilitySchedule | null;
};

export type CatalogSource = {
  owner(slug: string): Promise<Owner | null>;
  eventType(ownerId: string, slug: string): Promise<EventType | null>;
  /**
   * Resolves a **persisted** `eventTypeId` back to its row. A booking stores the
   * id, not the slug, and the id is only guaranteed to be the deterministic C1
   * string for records materialization wrote — a retained fixture row may carry
   * a plain uuid, so deriving the slug from the id is not safe.
   */
  eventTypeById(id: string): Promise<EventType | null>;
  schedule(scheduleId: string): Promise<AvailabilitySchedule | null>;
};

/**
 * Resolves `(ownerSlug, eventSlug)` with read-only lookups. A reserved owner
 * slug never reaches a store read (REV5-06).
 */
export async function resolveCatalog(
  source: CatalogSource,
  ownerSlug: string,
  eventSlug: string,
): Promise<ResolvedCatalog> {
  const normalizedOwner = normalizeSlug(ownerSlug);
  if (!isValidSlug(normalizedOwner) || isReservedRootSlug(normalizedOwner)) {
    // Never a store read for an application-owned root segment.
    throw new OwnerNotFoundError();
  }
  const owner = await source.owner(normalizedOwner);
  if (owner === null) {
    throw new OwnerNotFoundError();
  }
  const normalizedEvent = normalizeSlug(eventSlug);
  if (!isValidSlug(normalizedEvent)) {
    throw new EventTypeNotFoundError();
  }
  const eventType = await source.eventType(owner.id, normalizedEvent);
  if (eventType === null) {
    throw new EventTypeNotFoundError();
  }
  const schedule = await source.schedule(eventType.availabilityScheduleId);
  return { owner, eventType, schedule };
}

/**
 * C6.9 — the kind gate. Called immediately after resolution and before any
 * booking side effect. In memory mode group/collective rows keep their existing
 * fixture path, so the gate applies only when the durable store is in use.
 */
export function assertLiveKind(kind: EventTypeKind, durable: boolean): void {
  if (!durable) {
    return;
  }
  if (kind === GROUP) {
    throw new GroupNotSupportedError();
  }
  if (kind === COLLECTIVE) {
    throw new CollectiveNotSupportedError();
  }
}

export function isFixtureOnlyKind(kind: EventTypeKind): boolean {
  return kind === GROUP || kind === COLLECTIVE;
}

/** The in-memory catalog source (fixtures + materialized owners). */
export function memoryCatalogSource(owners: {
  getBySlug(slug: string): Promise<Owner | null>;
}): CatalogSource {
  return {
    owner: (slug) => owners.getBySlug(slug),
    eventType: async (ownerId, slug) => resolveEventType(ownerId, slug),
    eventTypeById: async (id) => getEventType(id),
    schedule: async (scheduleId) => getAvailabilitySchedule(scheduleId),
  };
}

export const SELECT_EVENT_TYPE_SQL = `SELECT id, owner_id, slug, kind, duration_min, capacity,
    notification_mode, schedule_id, name
  FROM event_types WHERE owner_id = $1 AND slug = $2`;

export const SELECT_EVENT_TYPE_BY_ID_SQL = `SELECT id, owner_id, slug, kind, duration_min, capacity,
    notification_mode, schedule_id, name
  FROM event_types WHERE id = $1`;

export const SELECT_SCHEDULE_SQL =
  'SELECT id, owner_id, timezone, rules FROM availability_schedules WHERE id = $1';

/**
 * The durable catalog source. These are the only statements AC-24 permits
 * before the 404 / 501 answer: read-only catalog `SELECT`s, no lock, no
 * `bookings` / `create_rejections` statement, no Google, no Gmail.
 */
export function pgCatalogSource(
  db: Queryable,
  owners: { getBySlug(slug: string): Promise<Owner | null> },
): CatalogSource {
  return {
    owner: (slug) => owners.getBySlug(slug),
    async eventType(ownerId, slug) {
      const result = await db.query(SELECT_EVENT_TYPE_SQL, [ownerId, slug]);
      if (result.rows.length === 0) {
        return null;
      }
      return mapEventType(result.rows[0]);
    },
    async eventTypeById(id) {
      const result = await db.query(SELECT_EVENT_TYPE_BY_ID_SQL, [id]);
      if (result.rows.length === 0) {
        return null;
      }
      return mapEventType(result.rows[0]);
    },
    async schedule(scheduleId) {
      const result = await db.query(SELECT_SCHEDULE_SQL, [scheduleId]);
      if (result.rows.length === 0) {
        return null;
      }
      return mapSchedule(result.rows[0]);
    },
  };
}

function mapEventType(raw: Record<string, unknown>): EventType {
  const kind = kindOf(raw.kind);
  const eventType: EventType = {
    id: String(raw.id),
    ownerId: String(raw.owner_id),
    // One host per owner in this slice (single-host live path).
    hostId: String(raw.owner_id),
    slug: String(raw.slug),
    name: String(raw.name ?? ''),
    durationMinutes: Number(raw.duration_min),
    availabilityScheduleId: String(raw.schedule_id),
    kind,
    notificationMode:
      raw.notification_mode === 'calendar_invitation'
        ? 'calendar_invitation'
        : 'email_confirmation',
  };
  if (kind === GROUP && raw.capacity !== null && raw.capacity !== undefined) {
    eventType.maxInvitees = Number(raw.capacity);
  }
  return eventType;
}

function kindOf(value: unknown): EventTypeKind {
  if (value === GROUP || value === COLLECTIVE) {
    return value;
  }
  return 'one_on_one';
}

function mapSchedule(raw: Record<string, unknown>): AvailabilitySchedule {
  const rules = raw.rules;
  const parsed = typeof rules === 'string' ? safeParse(rules) : rules;
  const windows = Array.isArray(parsed)
    ? parsed
        .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
        .map((entry) => ({
          weekday: Number(entry.weekday),
          start: String(entry.start),
          end: String(entry.end),
        }))
    : [];
  return {
    id: String(raw.id),
    hostId: String(raw.owner_id),
    timezone: String(raw.timezone),
    windows,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}
