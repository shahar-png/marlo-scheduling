import { buildWebhookPayload, type WebhookBooking } from './events';
import {
  getWebhookHttp,
  type WebhookHttp,
  type WebhookHttpResult,
} from './http';
import {
  listFailedWebhookDeliveries,
  recordWebhookDelivery,
  updateWebhookDelivery,
  WEBHOOK_DELIVERED,
  WEBHOOK_FAILED,
  type WebhookDelivery,
} from './log';
import { signWebhookPayload, WEBHOOK_SIGNATURE_HEADER } from './signature';
import {
  getWebhookSubscription,
  listWebhookSubscriptions,
  type WebhookEvent,
} from './subscription';

export type DeliverBookingWebhookInput = {
  booking: WebhookBooking;
  event: WebhookEvent;
  http?: WebhookHttp;
};

export async function deliverBookingWebhook(
  input: DeliverBookingWebhookInput,
): Promise<WebhookDelivery[]> {
  const http = input.http ?? getWebhookHttp();
  const subscriptions = listWebhookSubscriptions(input.booking.hostId).filter(
    (row) => row.events.includes(input.event),
  );

  const results: WebhookDelivery[] = [];
  for (const subscription of subscriptions) {
    const payload = buildWebhookPayload({
      event: input.event,
      booking: input.booking,
    });
    const body = JSON.stringify(payload);
    const signature = signWebhookPayload(body, subscription.secret);
    const posted = await postWebhook(http, subscription.url, body, signature);
    results.push(
      recordWebhookDelivery({
        subscriptionId: subscription.id,
        event: input.event,
        bookingId: input.booking.id,
        status: isDelivered(posted.status) ? WEBHOOK_DELIVERED : WEBHOOK_FAILED,
        attempts: 1,
        payload: body,
        signature,
        ...(posted.status !== undefined
          ? { responseStatus: posted.status }
          : {}),
      }),
    );
  }
  return results;
}

export async function retryFailedWebhookDeliveries(
  http: WebhookHttp = getWebhookHttp(),
): Promise<WebhookDelivery[]> {
  const failed = listFailedWebhookDeliveries();
  const updated: WebhookDelivery[] = [];

  for (const row of failed) {
    const subscription = getWebhookSubscription(row.subscriptionId);
    if (!subscription) {
      continue;
    }
    const posted = await postWebhook(
      http,
      subscription.url,
      row.payload,
      row.signature,
    );
    updated.push(
      updateWebhookDelivery(row.id, {
        status: isDelivered(posted.status) ? WEBHOOK_DELIVERED : WEBHOOK_FAILED,
        attempts: row.attempts + 1,
        ...(posted.status !== undefined
          ? { responseStatus: posted.status }
          : {}),
      }),
    );
  }

  return updated;
}

async function postWebhook(
  http: WebhookHttp,
  url: string,
  body: string,
  signature: string,
): Promise<{ status?: number }> {
  try {
    const result: WebhookHttpResult = await http.post(url, body, {
      'content-type': 'application/json',
      [WEBHOOK_SIGNATURE_HEADER]: signature,
    });
    return { status: result.status };
  } catch {
    return {};
  }
}

function isDelivered(status: number | undefined): boolean {
  return status !== undefined && status >= 200 && status < 300;
}
