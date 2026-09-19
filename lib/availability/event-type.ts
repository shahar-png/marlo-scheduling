export const ONE_ON_ONE = 'one_on_one' as const;
export const REJECTED_EVENT_TYPE_KINDS = [
  'group',
  'collective',
  'round_robin',
] as const;

export type EventTypeKind = typeof ONE_ON_ONE;

export type EventType = {
  id: string;
  hostId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  availabilityScheduleId: string;
  kind: EventTypeKind;
};

export type CreateEventTypeInput = {
  hostId: string;
  slug: string;
  name: string;
  durationMinutes: number;
  availabilityScheduleId: string;
  kind: string;
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
  if (input.kind !== ONE_ON_ONE) {
    throw new Error(
      `kind must be "${ONE_ON_ONE}"; ${input.kind} event types are rejected`,
    );
  }
  if (slugs.has(slug)) {
    throw new Error('slug must be unique');
  }

  const eventType: EventType = {
    id: crypto.randomUUID(),
    hostId,
    slug,
    name,
    durationMinutes: input.durationMinutes,
    availabilityScheduleId,
    kind: ONE_ON_ONE,
  };
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
