import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  CALENDAR_INVITATION,
  createEventType,
  EMAIL_CONFIRMATION,
  getEventType,
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
import { createMockEmailProvider, resetEmailMessages } from '../lib/notify/email';
import { listNotificationLog, resetNotificationLog } from '../lib/notify/log';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
    'utf8',
  ),
) as GoogleFreeBusyFixture;

const SLOT_0900 = '2026-09-20T09:00:00.000Z';
const SLOT_0930 = '2026-09-20T09:30:00.000Z';
const SLOT_1400 = '2026-09-20T14:00:00.000Z';

function seedEventType(
  slug: string,
  notificationMode?: string,
) {
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

describe('AC-1 event type notificationMode', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
  });

  it('creates and reads calendar_invitation and email_confirmation modes', () => {
    const calendar = seedEventType('intro-cal', CALENDAR_INVITATION);
    assert.equal(calendar.notificationMode, CALENDAR_INVITATION);
    assert.deepEqual(getEventType(calendar.id), calendar);

    const email = seedEventType('intro-mail', EMAIL_CONFIRMATION);
    assert.equal(email.notificationMode, EMAIL_CONFIRMATION);
    assert.deepEqual(getEventType(email.id), email);
  });

  it('defaults omitted mode to calendar_invitation', () => {
    const created = seedEventType('intro-default');
    assert.equal(created.notificationMode, CALENDAR_INVITATION);
    assert.equal(getEventType(created.id)?.notificationMode, CALENDAR_INVITATION);
  });

  it('rejects empty or unknown modes', () => {
    assert.throws(() => seedEventType('bad-empty', '   '), /notificationMode/);
    assert.throws(() => seedEventType('bad-sms', 'sms'), /notificationMode/);
  });
});

describe('AC-2 EmailProvider mock', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetEmailMessages();
    resetNotificationLog();
  });

  it('records send on email_confirmation create/reschedule/cancel and never calls Gmail', async () => {
    const eventType = seedEventType('intro-mail', EMAIL_CONFIRMATION);
    const calendar = createFixtureCalendarProvider(FIXTURE);
    const email = createMockEmailProvider();

    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });

    const moved = await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });

    await cancelBooking({
      bookingId: moved.id,
      reason: 'cannot make it',
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });

    assert.deepEqual(
      email.sent.map((row) => row.template),
      ['booking_confirmation', 'booking_rescheduled', 'booking_cancelled'],
    );
    assert.equal(email.sent[0]?.to, 'ada@example.com');
    assert.equal(email.sent[0]?.subject, 'Booking confirmed');
    assert.equal(email.sent[0]?.bookingId, created.id);
    assert.match(email.sent[0]?.id ?? '', /^mock-email-/);
  });

  it('does not call EmailProvider on the calendar_invitation path', async () => {
    const eventType = seedEventType('intro-cal', CALENDAR_INVITATION);
    const calendar = createFixtureCalendarProvider(FIXTURE);
    const email = createMockEmailProvider();

    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });
    await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });
    await cancelBooking({
      bookingId: created.id,
      reason: 'changed plans',
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });

    assert.equal(email.sent.length, 0);
  });
});

describe('AC-3 calendar invite vs email occupancy writes', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetEmailMessages();
    resetNotificationLog();
  });

  it('includes the invitee as an attendee on calendar_invitation create/patch', async () => {
    const eventType = seedEventType('intro-cal', CALENDAR_INVITATION);
    const provider = createFixtureCalendarProvider(FIXTURE);

    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    assert.equal(provider.createdEvents.length, 1);
    assert.deepEqual(provider.createdEvents[0]?.attendees, [
      { email: 'ada@example.com', displayName: 'Ada Lovelace' },
    ]);

    await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider,
      calendarId: 'primary',
    });

    assert.equal(provider.patchedEvents.length, 1);
    assert.equal(provider.patchedEvents[0]?.eventId, created.calendarEventId);
    assert.equal(provider.patchedEvents[0]?.start, SLOT_0930);
    assert.deepEqual(provider.patchedEvents[0]?.attendees, [
      { email: 'ada@example.com', displayName: 'Ada Lovelace' },
    ]);
  });

  it('omits attendees on email_confirmation create/patch and still writes the host block', async () => {
    const eventType = seedEventType('intro-mail', EMAIL_CONFIRMATION);
    const provider = createFixtureCalendarProvider(FIXTURE);
    const email = createMockEmailProvider();

    const created = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
      emailProvider: email,
    });

    assert.equal(provider.createdEvents.length, 1);
    assert.equal(provider.createdEvents[0]?.attendees, undefined);
    assert.equal(provider.createdEvents[0]?.id, created.calendarEventId);

    await rescheduleBooking({
      bookingId: created.id,
      start: SLOT_0930,
      provider,
      calendarId: 'primary',
      emailProvider: email,
    });

    assert.equal(provider.patchedEvents.length, 1);
    assert.equal(provider.patchedEvents[0]?.attendees, undefined);

    await cancelBooking({
      bookingId: created.id,
      reason: 'cannot make it',
      provider,
      calendarId: 'primary',
      emailProvider: email,
    });
    assert.deepEqual(provider.deletedEventIds, [created.calendarEventId]);
  });
});

describe('AC-4 notification_log', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetEmailMessages();
    resetNotificationLog();
  });

  it('records one row per successful create/reschedule/cancel with mode and channel', async () => {
    const calendarType = seedEventType('intro-cal', CALENDAR_INVITATION);
    const emailType = seedEventType('intro-mail', EMAIL_CONFIRMATION);
    const calendar = createFixtureCalendarProvider(FIXTURE);
    const email = createMockEmailProvider();

    const invited = await bookAvailableSlot({
      eventType: calendarType,
      start: SLOT_0900,
      invitee: { name: 'Ada', email: 'ada@example.com' },
      provider: calendar,
      calendarId: 'primary',
    });
    await rescheduleBooking({
      bookingId: invited.id,
      start: SLOT_0930,
      provider: calendar,
      calendarId: 'primary',
    });
    await cancelBooking({
      bookingId: invited.id,
      reason: 'cannot make it',
      provider: calendar,
      calendarId: 'primary',
    });

    const mailed = await bookAvailableSlot({
      eventType: emailType,
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider: calendar,
      calendarId: 'primary',
      emailProvider: email,
    });

    const invitedRows = listNotificationLog(invited.id);
    assert.deepEqual(
      invitedRows.map((row) => ({
        action: row.action,
        mode: row.mode,
        channel: row.channel,
      })),
      [
        { action: 'create', mode: CALENDAR_INVITATION, channel: 'calendar' },
        { action: 'reschedule', mode: CALENDAR_INVITATION, channel: 'calendar' },
        { action: 'cancel', mode: CALENDAR_INVITATION, channel: 'calendar' },
      ],
    );
    assert.equal(invitedRows[0]?.bookingId, invited.id);

    const mailedRows = listNotificationLog(mailed.id);
    assert.equal(mailedRows.length, 1);
    assert.equal(mailedRows[0]?.mode, EMAIL_CONFIRMATION);
    assert.equal(mailedRows[0]?.channel, 'email');
    assert.equal(mailedRows[0]?.action, 'create');
  });

  it('does not record a row on 409 conflict', async () => {
    const eventType = seedEventType('intro-cal', CALENDAR_INVITATION);
    const provider = createFixtureCalendarProvider(FIXTURE);

    await assert.rejects(
      () =>
        bookAvailableSlot({
          eventType,
          start: SLOT_1400,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider,
          calendarId: 'primary',
        }),
      BookingConflictError,
    );

    assert.equal(listNotificationLog().length, 0);
  });
});
