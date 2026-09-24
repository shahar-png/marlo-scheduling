export const ONE_ON_ONE = 'one_on_one' as const;
export const GROUP = 'group' as const;
export const COLLECTIVE = 'collective' as const;
export const CALENDAR_INVITATION = 'calendar_invitation' as const;
export const EMAIL_CONFIRMATION = 'email_confirmation' as const;
export const REJECTED_EVENT_TYPE_KINDS = ['round_robin'] as const;

export type EventTypeKind =
  | typeof ONE_ON_ONE
  | typeof GROUP
  | typeof COLLECTIVE;
export type NotificationMode =
  | typeof CALENDAR_INVITATION
  | typeof EMAIL_CONFIRMATION;

export type EventType = {
  id: string;
  /** C1: every event type belongs to exactly one owner. */
  ownerId: string;
  hostId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  availabilityScheduleId: string;
  kind: EventTypeKind;
  notificationMode: NotificationMode;
  maxInvitees?: number;
  hostIds?: string[];
};

export type CreateEventTypeInput = {
  /** Omitted by fixture/test callers, which default to the demo owner (C1). */
  ownerId?: string;
  hostId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  availabilityScheduleId: string;
  kind: string;
  notificationMode?: string;
  maxInvitees?: number;
  hostIds?: string[];
  /** C1: deterministic id; omitted callers get a fresh uuid as before. */
  id?: string;
};

/** C1 — the demo owner every fixture caller belongs to. */
export const DEMO_OWNER_ID = 'own_demo';

const eventTypes = new Map<string, EventType>();
/** Keyed `ownerId\u0000slug` — uniqueness is per owner, not global (C1). */
const slugs = new Map<string, string>();

export function resetEventTypes(): void {
  eventTypes.clear();
  slugs.clear();
}

function slugKey(ownerId: string, slug: string): string {
  return `${ownerId}\u0000${slug}`;
}

export function createEventType(input: CreateEventTypeInput): EventType {
  const hostId = input.hostId.trim();
  const slug = input.slug.trim();
  const name = input.name.trim();
  const availabilityScheduleId = input.availabilityScheduleId.trim();

  if (!hostId) {
    throw new Error('hostId is required');
  }
  if (!slug) {
    throw new Error('slug is required');
  }
  if (!name) {
    throw new Error('name is required');
  }
  if (!availabilityScheduleId) {
    throw new Error('availabilityScheduleId is required');
  }
  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes <= 0
  ) {
    throw new Error('durationMinutes must be a positive integer');
  }
  if (
    input.kind !== ONE_ON_ONE &&
    input.kind !== GROUP &&
    input.kind !== COLLECTIVE
  ) {
    throw new Error(
      `kind must be "${ONE_ON_ONE}", "${GROUP}", or "${COLLECTIVE}"; ${input.kind} event types are rejected`,
    );
  }
  if (input.kind === GROUP) {
    if (
      !Number.isInteger(input.maxInvitees) ||
      (input.maxInvitees ?? 0) <= 0
    ) {
      throw new Error('maxInvitees must be a positive integer');
    }
  }
  const hostIds =
    input.kind === COLLECTIVE
      ? normalizeCollectiveHostIds(hostId, input.hostIds)
      : undefined;
  const ownerId = (input.ownerId ?? DEMO_OWNER_ID).trim();
  if (!ownerId) {
    throw new Error('ownerId is required');
  }
  // Uniqueness is `(ownerId, slug)`: two owners may both offer `intro-30`.
  if (slugs.has(slugKey(ownerId, slug))) {
    throw new Error('slug must be unique');
  }

  const notificationMode = resolveNotificationMode(input.notificationMode);

  const eventType: EventType = {
    id: input.id ?? crypto.randomUUID(),
    ownerId,
    hostId,
    slug,
    name,
    durationMinutes: input.durationMinutes,
    availabilityScheduleId,
    kind: input.kind,
    notificationMode,
  };
  if (input.kind === GROUP) {
    eventType.maxInvitees = input.maxInvitees;
  }
  if (input.kind === COLLECTIVE && hostIds) {
    eventType.hostIds = hostIds;
  }
  eventTypes.set(eventType.id, eventType);
  slugs.set(slugKey(ownerId, slug), eventType.id);
  return cloneEventType(eventType);
}

export function getEventType(id: string): EventType | null {
  const found = eventTypes.get(id);
  return found ? cloneEventType(found) : null;
}

/**
 * C1 / AC-2 — the owner-scoped lookup every route uses. A slug is resolved
 * **within one owner**; two owners may both offer `intro-30`.
 */
export function resolveEventType(ownerId: string, slug: string): EventType | null {
  const trimmed = slug.trim();
  // Exact first, then the lower-cased form (AC-2: slugs are lower-cased on
  // lookup; fixtures that registered a mixed-case slug still resolve exactly).
  const id =
    slugs.get(slugKey(ownerId, trimmed)) ??
    slugs.get(slugKey(ownerId, trimmed.toLowerCase()));
  return id ? getEventType(id) : null;
}

/**
 * Legacy lookup, resolved **only within the demo owner** (C2). The legacy
 * `/api/event-types/{slug}/*` routes answer 404 `owner_required` for anything
 * else; fixture callers that never pass an `ownerId` land here unchanged.
 */
export function getEventTypeBySlug(slug: string): EventType | null {
  return resolveEventType(DEMO_OWNER_ID, slug);
}

/**
 * Owners that offer this slug. The legacy `/api/event-types/{slug}/*` routes use
 * it to tell "no such event" from "that event belongs to another owner", which
 * is 404 `owner_required` (C2).
 */
export function ownersOfSlug(slug: string): string[] {
  const trimmed = slug.trim();
  const lowered = trimmed.toLowerCase();
  return [...eventTypes.values()]
    .filter((eventType) => eventType.slug === trimmed || eventType.slug === lowered)
    .map((eventType) => eventType.ownerId);
}

export function listEventTypesForOwner(ownerId: string): EventType[] {
  return [...eventTypes.values()]
    .filter((eventType) => eventType.ownerId === ownerId)
    .map(cloneEventType);
}

export function eventTypeHostIds(eventType: Pick<EventType, 'hostId' | 'hostIds'>): string[] {
  if (eventType.hostIds && eventType.hostIds.length > 0) {
    return [...eventType.hostIds];
  }
  return [eventType.hostId];
}

function normalizeCollectiveHostIds(
  organizerId: string,
  hostIds?: string[],
): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of [organizerId, ...(hostIds ?? [])]) {
    const id = raw.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    unique.push(id);
  }
  if (unique.length < 2) {
    throw new Error('hostIds must include at least two unique host ids');
  }
  return unique;
}

function cloneEventType(eventType: EventType): EventType {
  const cloned: EventType = { ...eventType };
  if (eventType.hostIds) {
    cloned.hostIds = [...eventType.hostIds];
  }
  return cloned;
}

export function resolveNotificationMode(
  mode?: string | null,
): NotificationMode {
  if (mode === undefined || mode === null) {
    return CALENDAR_INVITATION;
  }
  const trimmed = mode.trim();
  if (trimmed === CALENDAR_INVITATION || trimmed === EMAIL_CONFIRMATION) {
    return trimmed;
  }
  throw new Error(
    `notificationMode must be "${CALENDAR_INVITATION}" or "${EMAIL_CONFIRMATION}"`,
  );
}
