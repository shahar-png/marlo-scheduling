export const BOOKING_CREATED = 'booking.created' as const;
export const BOOKING_CANCELED = 'booking.canceled' as const;
export const BOOKING_RESCHEDULED = 'booking.rescheduled' as const;

export const WEBHOOK_EVENTS = [
  BOOKING_CREATED,
  BOOKING_CANCELED,
  BOOKING_RESCHEDULED,
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export type WebhookSubscription = {
  id: string;
  hostId: string;
  url: string;
  secret: string;
  events: WebhookEvent[];
};

export type CreateWebhookSubscriptionInput = {
  hostId: string;
  url: string;
  secret: string;
  events: string[];
};

const subscriptions = new Map<string, WebhookSubscription>();

export function resetWebhookSubscriptions(): void {
  subscriptions.clear();
}

export function createWebhookSubscription(
  input: CreateWebhookSubscriptionInput,
): WebhookSubscription {
  const hostId = input.hostId.trim();
  const url = input.url.trim();
  const secret = input.secret.trim();

  if (!hostId) {
    throw new Error('hostId is required');
  }
  if (!url) {
    throw new Error('url is required');
  }
  if (!secret) {
    throw new Error('secret is required');
  }
  assertHttpUrl(url);

  const events = normalizeEvents(input.events);

  const subscription: WebhookSubscription = {
    id: crypto.randomUUID(),
    hostId,
    url,
    secret,
    events,
  };
  subscriptions.set(subscription.id, subscription);
  return cloneSubscription(subscription);
}

export function getWebhookSubscription(
  id: string,
): WebhookSubscription | null {
  const found = subscriptions.get(id);
  return found ? cloneSubscription(found) : null;
}

export function listWebhookSubscriptions(
  hostId?: string,
): WebhookSubscription[] {
  const rows = hostId
    ? [...subscriptions.values()].filter((row) => row.hostId === hostId)
    : [...subscriptions.values()];
  return rows.map(cloneSubscription);
}

function normalizeEvents(events: string[]): WebhookEvent[] {
  if (!events || events.length === 0) {
    throw new Error('events must not be empty');
  }

  const normalized: WebhookEvent[] = [];
  const seen = new Set<string>();

  for (const raw of events) {
    const event = raw.trim();
    if (!event) {
      throw new Error('events must not be empty');
    }
    if (event.startsWith('routing_form.')) {
      throw new Error('routing_form events are not supported');
    }
    if (!isWebhookEvent(event)) {
      throw new Error(`unknown webhook event: ${event}`);
    }
    if (seen.has(event)) {
      throw new Error('events must not contain duplicates');
    }
    seen.add(event);
    normalized.push(event);
  }

  return normalized;
}

function isWebhookEvent(event: string): event is WebhookEvent {
  return (WEBHOOK_EVENTS as readonly string[]).includes(event);
}

function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('url must be http:// or https://');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be http:// or https://');
  }
}

function cloneSubscription(
  subscription: WebhookSubscription,
): WebhookSubscription {
  return {
    ...subscription,
    events: [...subscription.events],
  };
}
