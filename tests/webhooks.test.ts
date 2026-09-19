import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  createEventType,
  resetEventTypes,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import {
  bookAvailableSlot,
  BookingConflictError,
  cancelBooking,
  rescheduleBooking,
  resetBookings,
} from '../lib/booking/booking';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import {
  deliverBookingWebhook,
  retryFailedWebhookDeliveries,
} from '../lib/webhooks/deliver';
import { buildWebhookPayload } from '../lib/webhooks/events';
import {
  createMockWebhookHttp,
  resetWebhookHttp,
  setWebhookHttp,
} from '../lib/webhooks/http';
import {
  listFailedWebhookDeliveries,
  listWebhookDeliveries,
  resetWebhookDeliveries,
} from '../lib/webhooks/log';
import {
  signWebhookPayload,
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
} from '../lib/webhooks/signature';
import {
  BOOKING_CANCELED,
  BOOKING_CREATED,
  BOOKING_RESCHEDULED,
  createWebhookSubscription,
  getWebhookSubscription,
  listWebhookSubscriptions,
  resetWebhookSubscriptions,
} from '../lib/webhooks/subscription';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
    'utf8',
  ),
) as GoogleFreeBusyFixture;

const SLOT_0900 = '2026-09-20T09:00:00.000Z';
const SLOT_0930 = '2026-09-20T09:30:00.000Z';
const SLOT_1000 = '2026-09-20T10:00:00.000Z';
const SLOT_1400 = '2026-09-20T14:00:00.000Z';
const HOOK_URL = 'https://hooks.example.test/marlo';
const HOOK_SECRET = 'whsec_test_secret';

function seedEventType(slug = 'intro-30') {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug,
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'one_on_one',
  });
}

function seedSubscription(
  events: string[] = [BOOKING_CREATED, BOOKING_CANCELED, BOOKING_RESCHEDULED],
) {
  return createWebhookSubscription({
    hostId: 'host-1',
    url: HOOK_URL,
    secret: HOOK_SECRET,
    events,
  });
}

function independentHmac(body: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

describe('AC-1 webhook subscription stub', () => {
  beforeEach(() => {
    resetWebhookSubscriptions();
  });

  it('creates and reads a subscription with url, secret, and allowlisted events', () => {
    const created = seedSubscription([BOOKING_CREATED]);
    assert.equal(created.hostId, 'host-1');
    assert.equal(created.url, HOOK_URL);
    assert.equal(created.secret, HOOK_SECRET);
    assert.deepEqual(created.events, [BOOKING_CREATED]);
    assert.deepEqual(getWebhookSubscription(created.id), created);
    assert.deepEqual(listWebhookSubscriptions('host-1'), [created]);
    assert.deepEqual(listWebhookSubscriptions('other-host'), []);
  });

  it('rejects empty url/secret, non-http(s) url, empty events, duplicates, and unknown events', () => {
    const base = {
      hostId: 'host-1',
      url: HOOK_URL,
      secret: HOOK_SECRET,
      events: [BOOKING_CREATED],
    };

    assert.throws(
      () => createWebhookSubscription({ ...base, url: '   ' }),
      /url/,
    );
    assert.throws(
      () => createWebhookSubscription({ ...base, secret: '   ' }),
      /secret/,
    );
    assert.throws(
      () => createWebhookSubscription({ ...base, url: 'ftp://hooks.example.test' }),
      /http/,
    );
    assert.throws(
      () =>
        createWebhookSubscription({ ...base, url: 'javascript:alert(1)' }),
      /http/,
    );
    assert.throws(
      () => createWebhookSubscription({ ...base, events: [] }),
      /events/,
    );
    assert.throws(
      () =>
        createWebhookSubscription({
          ...base,
          events: [BOOKING_CREATED, BOOKING_CREATED],
        }),
      /duplicate/,
    );
    assert.throws(
      () =>
        createWebhookSubscription({
          ...base,
          events: ['routing_form.submitted'],
        }),
      /routing_form/,
    );
    assert.throws(
      () => createWebhookSubscription({ ...base, events: ['invitee.created'] }),
      /unknown webhook event/,
    );
  });
});

describe('AC-2 HMAC Marlo-Webhook-Signature', () => {
  it('signs the exact body as sha256=<hex> and verifies; wrong secret fails', () => {
    const body = JSON.stringify({
      event: BOOKING_CREATED,
      data: { booking: { id: 'bkg-1' } },
    });
    const header = signWebhookPayload(body, HOOK_SECRET);
    assert.equal(header, independentHmac(body, HOOK_SECRET));
    assert.match(header, /^sha256=[0-9a-f]{64}$/);
    assert.equal(WEBHOOK_SIGNATURE_HEADER, 'Marlo-Webhook-Signature');
    assert.equal(verifyWebhookSignature(body, HOOK_SECRET, header), true);
    assert.equal(
      verifyWebhookSignature(body, 'wrong-secret', header),
      false,
    );
    assert.equal(verifyWebhookSignature(body, HOOK_SECRET, 'sha256=00'), false);
  });
});

describe('AC-3 webhook payload shape', () => {
  it('builds envelopes for created, canceled, and rescheduled', () => {
    const booking = {
      id: 'bkg-1',
      hostId: 'host-1',
      eventTypeId: 'et-1',
      start: SLOT_0900,
      end: SLOT_0930,
      status: 'confirmed',
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    };

    for (const event of [
      BOOKING_CREATED,
      BOOKING_CANCELED,
      BOOKING_RESCHEDULED,
    ] as const) {
      const payload = buildWebhookPayload({
        event,
        booking:
          event === BOOKING_CANCELED
            ? { ...booking, status: 'cancelled' }
            : booking,
      });
      assert.equal(payload.event, event);
      assert.match(payload.id, /^[0-9a-f-]{36}$/i);
      assert.equal(Number.isNaN(Date.parse(payload.createdAt)), false);
      assert.deepEqual(payload.data.booking, {
        id: 'bkg-1',
        hostId: 'host-1',
        eventTypeId: 'et-1',
        start: SLOT_0900,
        end: event === BOOKING_CANCELED ? SLOT_0930 : SLOT_0930,
        status: event === BOOKING_CANCELED ? 'cancelled' : 'confirmed',
        invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      });
    }
  });
});

describe('AC-4 lifecycle emit', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetWebhookSubscriptions();
    resetWebhookDeliveries();
    resetWebhookHttp();
  });

  it('emits signed booking.created/rescheduled/canceled to matching subscriptions', async () => {
    const eventType = seedEventType();
    const subscription = seedSubscription();
    const http = createMockWebhookHttp();
    setWebhookHttp(http);
    const calendar = createFixtureCalendarProvider(FIXTURE);

    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: calendar,
      calendarId: 'primary',
    });
    const moved = await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider: calendar,
      calendarId: 'primary',
    });
    await cancelBooking({
      bookingId: moved.id,
      reason: 'cannot make it',
      provider: calendar,
      calendarId: 'primary',
    });

    assert.equal(http.posts.length, 3);
    assert.deepEqual(
      http.posts.map((row) => (JSON.parse(row.body) as { event: string }).event),
      [BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELED],
    );

    for (const post of http.posts) {
      assert.equal(post.url, HOOK_URL);
      assert.equal(post.headers['content-type'], 'application/json');
      const header = post.headers[WEBHOOK_SIGNATURE_HEADER];
      assert.equal(header, independentHmac(post.body, HOOK_SECRET));
      assert.equal(
        verifyWebhookSignature(post.body, HOOK_SECRET, header),
        true,
      );
      const envelope = JSON.parse(post.body) as {
        data: {
          booking: {
            id: string;
            hostId: string;
            eventTypeId: string;
            start: string;
            end: string;
            invitee: { name: string; email: string };
          };
        };
      };
      assert.equal(envelope.data.booking.id, created.id);
      assert.equal(envelope.data.booking.hostId, 'host-1');
      assert.equal(envelope.data.booking.eventTypeId, eventType.id);
      assert.equal(envelope.data.booking.invitee.email, 'ada@example.com');
      assert.equal(envelope.data.booking.invitee.name, 'Ada Lovelace');
    }

    assert.equal(http.posts[0] && JSON.parse(http.posts[0].body).data.booking.start, SLOT_0900);
    assert.equal(http.posts[1] && JSON.parse(http.posts[1].body).data.booking.start, SLOT_0930);
    assert.equal(
      http.posts[2] && JSON.parse(http.posts[2].body).data.booking.status,
      'cancelled',
    );

    const rows = listWebhookDeliveries(created.id);
    assert.deepEqual(
      rows.map((row) => ({
        event: row.event,
        status: row.status,
        subscriptionId: row.subscriptionId,
        attempts: row.attempts,
      })),
      [
        {
          event: BOOKING_CREATED,
          status: 'delivered',
          subscriptionId: subscription.id,
          attempts: 1,
        },
        {
          event: BOOKING_RESCHEDULED,
          status: 'delivered',
          subscriptionId: subscription.id,
          attempts: 1,
        },
        {
          event: BOOKING_CANCELED,
          status: 'delivered',
          subscriptionId: subscription.id,
          attempts: 1,
        },
      ],
    );
  });

  it('does not emit on 409 conflict or to a different host', async () => {
    const eventType = seedEventType();
    createWebhookSubscription({
      hostId: 'other-host',
      url: HOOK_URL,
      secret: HOOK_SECRET,
      events: [BOOKING_CREATED],
    });
    const http = createMockWebhookHttp();
    setWebhookHttp(http);
    const calendar = createFixtureCalendarProvider(FIXTURE);

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_1400,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider: calendar,
          calendarId: 'primary',
        }),
      BookingConflictError,
    );

    assert.equal(http.posts.length, 0);
    assert.equal(listWebhookDeliveries().length, 0);

    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider: calendar,
      calendarId: 'primary',
    });
    assert.ok(created.id);
    assert.equal(http.posts.length, 0);
    assert.equal(listWebhookDeliveries().length, 0);
  });
});

describe('AC-5 delivery log + retry stub', () => {
  beforeEach(() => {
    resetWebhookSubscriptions();
    resetWebhookDeliveries();
    resetWebhookHttp();
  });

  it('records failed deliveries and retries through mock fetch until success', async () => {
    const subscription = seedSubscription([BOOKING_CREATED]);
    let calls = 0;
    const http = createMockWebhookHttp({
      statusFor() {
        calls += 1;
        return calls === 1 ? 500 : 200;
      },
    });

    const booking = {
      id: 'bkg-retry',
      hostId: 'host-1',
      eventTypeId: 'et-1',
      start: SLOT_0900,
      end: SLOT_1000,
      status: 'confirmed',
      invitee: { name: 'Ada', email: 'ada@example.com' },
    };

    const first = await deliverBookingWebhook({
      booking,
      event: BOOKING_CREATED,
      http,
    });
    assert.equal(first.length, 1);
    assert.equal(first[0]?.status, 'failed');
    assert.equal(first[0]?.attempts, 1);
    assert.equal(first[0]?.responseStatus, 500);
    assert.equal(first[0]?.subscriptionId, subscription.id);
    assert.equal(listFailedWebhookDeliveries().length, 1);
    assert.equal(
      first[0]?.signature,
      independentHmac(first[0]?.payload ?? '', HOOK_SECRET),
    );

    const retried = await retryFailedWebhookDeliveries(http);
    assert.equal(retried.length, 1);
    assert.equal(retried[0]?.status, 'delivered');
    assert.equal(retried[0]?.attempts, 2);
    assert.equal(retried[0]?.responseStatus, 200);
    assert.equal(listFailedWebhookDeliveries().length, 0);
    assert.equal(http.posts.length, 2);
    assert.equal(http.posts[0]?.body, http.posts[1]?.body);
    assert.equal(
      http.posts[0]?.headers[WEBHOOK_SIGNATURE_HEADER],
      http.posts[1]?.headers[WEBHOOK_SIGNATURE_HEADER],
    );
    assert.equal(listWebhookDeliveries('bkg-retry').length, 1);
  });
});
