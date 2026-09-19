import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { POST as cancelPOST } from '../app/api/bookings/[id]/cancel/route';
import { POST as reschedulePOST } from '../app/api/bookings/[id]/reschedule/route';
import {
  POST as createBookingPOST,
  setBookingCalendarProvider,
} from '../app/api/event-types/[slug]/bookings/route';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { resetBookings } from '../lib/booking/booking';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import {
  createMockWebhookHttp,
  resetWebhookHttp,
  setWebhookHttp,
} from '../lib/webhooks/http';
import {
  listWebhookDeliveries,
  resetWebhookDeliveries,
} from '../lib/webhooks/log';
import { WEBHOOK_SIGNATURE_HEADER } from '../lib/webhooks/signature';
import {
  BOOKING_CANCELED,
  BOOKING_CREATED,
  BOOKING_RESCHEDULED,
  createWebhookSubscription,
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
const HOOK_URL = 'https://hooks.example.test/marlo';
const HOOK_SECRET = 'whsec_route_secret';

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

function createRequest(slug: string, body: unknown): Promise<Response> {
  return createBookingPOST(
    new Request(`http://localhost/api/event-types/${slug}/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ slug }) },
  );
}

function rescheduleRequest(id: string, body: unknown): Promise<Response> {
  return reschedulePOST(
    new Request(`http://localhost/api/bookings/${id}/reschedule`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

function cancelRequest(id: string, body: unknown): Promise<Response> {
  return cancelPOST(
    new Request(`http://localhost/api/bookings/${id}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe('AC-4 public booking routes emit signed webhooks', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    resetWebhookSubscriptions();
    resetWebhookDeliveries();
    resetWebhookHttp();
    setBookingCalendarProvider(null);
  });

  it('POSTs signed envelopes on create, reschedule, and cancel handlers', async () => {
    seedEventType('intro-30');
    createWebhookSubscription({
      hostId: 'host-1',
      url: HOOK_URL,
      secret: HOOK_SECRET,
      events: [BOOKING_CREATED, BOOKING_CANCELED, BOOKING_RESCHEDULED],
    });
    const http = createMockWebhookHttp();
    setWebhookHttp(http);
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const created = await createRequest('intro-30', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { booking: { id: string } };

    const moved = await rescheduleRequest(createdBody.booking.id, {
      start: SLOT_0930,
    });
    assert.equal(moved.status, 200);

    const cancelled = await cancelRequest(createdBody.booking.id, {
      reason: 'cannot make it',
    });
    assert.equal(cancelled.status, 200);

    assert.equal(http.posts.length, 3);
    assert.deepEqual(
      http.posts.map((row) => (JSON.parse(row.body) as { event: string }).event),
      [BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELED],
    );

    for (const post of http.posts) {
      const expected = `sha256=${createHmac('sha256', HOOK_SECRET)
        .update(post.body, 'utf8')
        .digest('hex')}`;
      assert.equal(post.headers[WEBHOOK_SIGNATURE_HEADER], expected);
      assert.equal(post.url, HOOK_URL);
    }

    const rows = listWebhookDeliveries(createdBody.booking.id);
    assert.deepEqual(
      rows.map((row) => row.event),
      [BOOKING_CREATED, BOOKING_RESCHEDULED, BOOKING_CANCELED],
    );
    assert.ok(rows.every((row) => row.status === 'delivered'));
  });
});
