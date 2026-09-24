import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { POST as cancelPOST } from '../app/api/bookings/[id]/cancel/route';
import { POST as reschedulePOST } from '../app/api/bookings/[id]/reschedule/route';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { EMAIL_CONFIRMATION } from '../lib/availability/event-type';
import {
  createEventType,
  getEventTypeBySlug,
  resetEventTypes,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { bookAvailableSlot, resetBookings } from '../lib/booking/booking';
import { getBookingCalendarProvider } from '../lib/booking/calendar-runtime';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { listSentEmails, resetEmailMessages } from '../lib/notify/email';
import { setBookingEmailProvider } from '../lib/notify/email-runtime';
import { listNotificationLog, resetNotificationLog } from '../lib/notify/log';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
    'utf8',
  ),
) as GoogleFreeBusyFixture;

const SLOT_0900 = '2026-09-20T09:00:00.000Z';
const SLOT_0930 = '2026-09-20T09:30:00.000Z';

function seedEventType(slug: string, notificationMode?: string) {
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
    ...(notificationMode === undefined ? {} : { notificationMode }),
  });
}

// The subject here is the notification the **booking service** dispatches,
// which fires from `bookAvailableSlot` itself. Creating the fixture booking
// through the library keeps that subject intact now that the legacy HTTP route
// sends `one_on_one` creates through the shared C6 lifecycle instead (C2).
async function createRequest(
  slug: string,
  body: { start: string; invitee: { name: string; email: string } },
): Promise<Response> {
  const eventType = getEventTypeBySlug(slug);
  if (!eventType) {
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }
  const booking = await bookAvailableSlot({
    eventType,
    start: body.start,
    invitee: body.invitee,
    provider: getBookingCalendarProvider(),
    calendarId: 'primary',
  });
  return Response.json({ booking }, { status: 201 });
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

describe('AC-5 public booking routes emit notification_log', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
    resetNotificationLog();
    resetEmailMessages();
    setBookingCalendarProvider(null);
    setBookingEmailProvider(null);
  });

  it('records a log row on create, reschedule, and cancel handlers', async () => {
    seedEventType('intro-30');
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

    const rows = listNotificationLog(createdBody.booking.id);
    assert.deepEqual(
      rows.map((row) => ({
        action: row.action,
        mode: row.mode,
        channel: row.channel,
      })),
      [
        {
          action: 'create',
          mode: 'calendar_invitation',
          channel: 'calendar',
        },
        {
          action: 'reschedule',
          mode: 'calendar_invitation',
          channel: 'calendar',
        },
        {
          action: 'cancel',
          mode: 'calendar_invitation',
          channel: 'calendar',
        },
      ],
    );
    assert.equal(listSentEmails().length, 0);
  });

  it('sends mock email and logs channel email for email_confirmation create', async () => {
    seedEventType('intro-mail', EMAIL_CONFIRMATION);
    setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));

    const created = await createRequest('intro-mail', {
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { booking: { id: string } };

    const sent = listSentEmails();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.template, 'booking_confirmation');
    assert.equal(sent[0]?.to, 'ada@example.com');

    const rows = listNotificationLog(body.booking.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.channel, 'email');
    assert.equal(rows[0]?.mode, EMAIL_CONFIRMATION);
  });
});
