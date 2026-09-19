import type { WebhookEvent } from './subscription';

export type WebhookBooking = {
  id: string;
  hostId: string;
  eventTypeId: string;
  start: string;
  end: string;
  status: string;
  invitee: { name: string; email: string };
};

export type WebhookPayload = {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  data: {
    booking: WebhookBooking;
  };
};

export type BuildWebhookPayloadInput = {
  event: WebhookEvent;
  booking: WebhookBooking;
};

export function buildWebhookPayload(
  input: BuildWebhookPayloadInput,
): WebhookPayload {
  return {
    id: crypto.randomUUID(),
    event: input.event,
    createdAt: new Date().toISOString(),
    data: {
      booking: {
        id: input.booking.id,
        hostId: input.booking.hostId,
        eventTypeId: input.booking.eventTypeId,
        start: input.booking.start,
        end: input.booking.end,
        status: input.booking.status,
        invitee: {
          name: input.booking.invitee.name,
          email: input.booking.invitee.email,
        },
      },
    },
  };
}
