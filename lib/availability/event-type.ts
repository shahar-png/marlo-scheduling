export const ONE_ON_ONE = 'one_on_one' as const;
export const GROUP = 'group' as const;
export const CALENDAR_INVITATION = 'calendar_invitation' as const;
export const EMAIL_CONFIRMATION = 'email_confirmation' as const;
export const REJECTED_EVENT_TYPE_KINDS = [
  'collective',
  'round_robin',
] as const;

export type EventTypeKind = typeof ONE_ON_ONE | typeof GROUP;
export type NotificationMode =
  | typeof CALENDAR_INVITATION
  | typeof EMAIL_CONFIRMATION;

export type EventType = {
  id: string;
  hostId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  availabilityScheduleId: string;
  kind: EventTypeKind;
  notificationMode: NotificationMode;
  maxInvitees?: number;
};

export type CreateEventTypeInput = {
  hostId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  availabilityScheduleId: string;
  kind: string;
  notificationMode?: string;
  maxInvitees?: number;
};

const eventTypes = new Map<string, EventType>();
const slugs = new Map<string, string>();

export function resetEventTypes(): void {
  eventTypes.clear();
  slugs.clear();
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
  if (input.kind === GROUP) {
    if (
      input.maxInvitees === undefined ||
      !Number.isInteger(input.maxInvitees) ||
      input.maxInvitees <= 0
    ) {
      throw new Error('maxInvitees must be a positive integer');
    }
  } else if (input.kind !== ONE_ON_ONE) {
    throw new Error(
      `kind must be "${ONE_ON_ONE}" or "${GROUP}"; ${input.kind} event types are rejected`,
    );
  }
  if (slugs.has(slug)) {
    throw new Error('slug must be unique');
  }

  const notificationMode = resolveNotificationMode(input.notificationMode);

  const eventType: EventType = {
    id: crypto.randomUUID(),
    hostId,
    slug,
    name,
    durationMinutes: input.durationMinutes,
    availabilityScheduleId,
    kind: input.kind === GROUP ? GROUP : ONE_ON_ONE,
    notificationMode,
  };
  if (input.kind === GROUP) {
    eventType.maxInvitees = input.maxInvitees;
  }
  eventTypes.set(eventType.id, eventType);
  slugs.set(slug, eventType.id);
  return { ...eventType };
}

export function getEventType(id: string): EventType | null {
  const found = eventTypes.get(id);
  return found ? { ...found } : null;
}

export function getEventTypeBySlug(slug: string): EventType | null {
  const id = slugs.get(slug);
  return id ? getEventType(id) : null;
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
