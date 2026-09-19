import type { WebhookEvent } from './subscription';

export const WEBHOOK_DELIVERED = 'delivered' as const;
export const WEBHOOK_FAILED = 'failed' as const;

export type WebhookDeliveryStatus =
  | typeof WEBHOOK_DELIVERED
  | typeof WEBHOOK_FAILED;

export type WebhookDelivery = {
  id: string;
  subscriptionId: string;
  event: WebhookEvent;
  bookingId: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  payload: string;
  signature: string;
  responseStatus?: number;
  createdAt: string;
};

export type RecordWebhookDeliveryInput = {
  subscriptionId: string;
  event: WebhookEvent;
  bookingId: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  payload: string;
  signature: string;
  responseStatus?: number;
};

const deliveries: WebhookDelivery[] = [];

export function resetWebhookDeliveries(): void {
  deliveries.length = 0;
}

export function recordWebhookDelivery(
  input: RecordWebhookDeliveryInput,
): WebhookDelivery {
  const subscriptionId = input.subscriptionId.trim();
  const bookingId = input.bookingId.trim();
  if (!subscriptionId) {
    throw new Error('subscriptionId is required');
  }
  if (!bookingId) {
    throw new Error('bookingId is required');
  }
  if (!Number.isInteger(input.attempts) || input.attempts < 1) {
    throw new Error('attempts must be a positive integer');
  }

  const entry: WebhookDelivery = {
    id: crypto.randomUUID(),
    subscriptionId,
    event: input.event,
    bookingId,
    status: input.status,
    attempts: input.attempts,
    payload: input.payload,
    signature: input.signature,
    createdAt: new Date().toISOString(),
  };
  if (input.responseStatus !== undefined) {
    entry.responseStatus = input.responseStatus;
  }
  deliveries.push(entry);
  return cloneDelivery(entry);
}

export function listWebhookDeliveries(bookingId?: string): WebhookDelivery[] {
  const filtered = bookingId
    ? deliveries.filter((row) => row.bookingId === bookingId)
    : deliveries;
  return filtered.map(cloneDelivery);
}

export function listFailedWebhookDeliveries(): WebhookDelivery[] {
  return deliveries
    .filter((row) => row.status === WEBHOOK_FAILED)
    .map(cloneDelivery);
}

export function updateWebhookDelivery(
  id: string,
  patch: Partial<
    Pick<WebhookDelivery, 'status' | 'attempts' | 'responseStatus'>
  >,
): WebhookDelivery {
  const found = deliveries.find((row) => row.id === id);
  if (!found) {
    throw new Error('webhook delivery not found');
  }
  if (patch.status) {
    found.status = patch.status;
  }
  if (patch.attempts !== undefined) {
    found.attempts = patch.attempts;
  }
  if (patch.responseStatus !== undefined) {
    found.responseStatus = patch.responseStatus;
  }
  return cloneDelivery(found);
}

function cloneDelivery(entry: WebhookDelivery): WebhookDelivery {
  const cloned: WebhookDelivery = { ...entry };
  if (entry.responseStatus !== undefined) {
    cloned.responseStatus = entry.responseStatus;
  }
  return cloned;
}
