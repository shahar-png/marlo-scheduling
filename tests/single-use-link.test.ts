import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createOneOffMeeting,
  resetOneOffMeetings,
} from '../lib/availability/one-off';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import {
  createSingleUseLink,
  getSingleUseLink,
  getSingleUseLinkByToken,
  LINK_CONSUMED,
  LINK_UNUSED,
  resetSingleUseLinks,
} from '../lib/availability/single-use-link';
import {
  bookSingleUseLink,
  BookingConflictError,
  resetBookings,
} from '../lib/booking/booking';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
    'utf8',
  ),
) as GoogleFreeBusyFixture;

const SLOT_0900 = '2026-09-20T09:00:00.000Z';
const SLOT_1400 = '2026-09-20T14:00:00.000Z';

function seedIntro30() {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId: 'host-1',
    slug: 'intro-30',
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'one_on_one',
  });
}

function seedOffsite() {
  return createOneOffMeeting({
    hostId: 'host-1',
    name: 'Offsite',
    durationMinutes: 30,
    timezone: 'UTC',
    windows: [{ date: '2026-09-20', start: '09:00', end: '20:00' }],
  });
}

describe('AC-2 single-use scheduling-link stub', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetOneOffMeetings();
    resetSingleUseLinks();
  });

  it('creates and reads an unused link bound to an event type', () => {
    const eventType = seedIntro30();
    const created = createSingleUseLink({
      eventTypeId: eventType.id,
      token: 'link-event',
    });

    assert.equal(created.token, 'link-event');
    assert.equal(created.hostId, 'host-1');
    assert.equal(created.status, LINK_UNUSED);
    assert.equal(created.eventTypeId, eventType.id);
    assert.equal(created.oneOffMeetingId, undefined);
    assert.ok(created.id);
    assert.deepEqual(getSingleUseLink(created.id), created);
    assert.deepEqual(getSingleUseLinkByToken('link-event'), created);
  });

  it('creates and reads an unused link bound to a one-off meeting', () => {
    const meeting = seedOffsite();
    const created = createSingleUseLink({ oneOffMeetingId: meeting.id });

    assert.equal(created.status, LINK_UNUSED);
    assert.equal(created.oneOffMeetingId, meeting.id);
    assert.equal(created.eventTypeId, undefined);
    assert.ok(created.token);
    assert.deepEqual(getSingleUseLinkByToken(created.token), created);
  });

  it('rejects missing, dual, unknown, blank, and duplicate targets/tokens', () => {
    const eventType = seedIntro30();
    const meeting = seedOffsite();

    assert.throws(
      () => createSingleUseLink({}),
      /exactly one of eventTypeId or oneOffMeetingId is required/,
    );
    assert.throws(
      () =>
        createSingleUseLink({
          eventTypeId: eventType.id,
          oneOffMeetingId: meeting.id,
        }),
      /exactly one of eventTypeId or oneOffMeetingId is required/,
    );
    assert.throws(
      () => createSingleUseLink({ eventTypeId: 'missing' }),
      /event type not found/,
    );
    assert.throws(
      () => createSingleUseLink({ oneOffMeetingId: 'missing' }),
      /one-off meeting not found/,
    );
    assert.throws(
      () => createSingleUseLink({ eventTypeId: eventType.id, token: '   ' }),
      /token is required/,
    );

    createSingleUseLink({ eventTypeId: eventType.id, token: 'dup' });
    assert.throws(
      () => createSingleUseLink({ eventTypeId: eventType.id, token: 'dup' }),
      /token must be unique/,
    );
  });
});

describe('AC-4 book through unused single-use link consumes it', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetOneOffMeetings();
    resetSingleUseLinks();
    resetBookings();
  });

  it('confirms a booking on an event-type link and marks the link consumed', async () => {
    const eventType = seedIntro30();
    const link = createSingleUseLink({
      eventTypeId: eventType.id,
      token: 'use-once',
    });
    const provider = createFixtureCalendarProvider(FIXTURE);

    const booking = await bookSingleUseLink({
      token: link.token,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.start, SLOT_0900);
    assert.equal(booking.end, '2026-09-20T09:30:00.000Z');
    assert.equal(provider.createdEvents.length, 1);

    const consumed = getSingleUseLinkByToken('use-once');
    assert.equal(consumed?.status, LINK_CONSUMED);
    assert.equal(consumed?.bookingId, booking.id);
  });

  it('confirms a booking on a one-off link and consumes the token', async () => {
    const meeting = seedOffsite();
    const link = createSingleUseLink({
      oneOffMeetingId: meeting.id,
      token: 'off-once',
    });

    const booking = await bookSingleUseLink({
      token: link.token,
      start: SLOT_0900,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.start, SLOT_0900);
    const consumed = getSingleUseLinkByToken('off-once');
    assert.equal(consumed?.status, LINK_CONSUMED);
    assert.equal(consumed?.bookingId, booking.id);
  });

  it('does not consume the link on a 409 slot conflict', async () => {
    const meeting = seedOffsite();
    createSingleUseLink({
      oneOffMeetingId: meeting.id,
      token: 'still-open',
    });

    await assert.rejects(
      () =>
        bookSingleUseLink({
          token: 'still-open',
          start: SLOT_1400,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider: createFixtureCalendarProvider(FIXTURE),
          calendarId: 'primary',
        }),
      BookingConflictError,
    );

    assert.equal(getSingleUseLinkByToken('still-open')?.status, LINK_UNUSED);
  });
});
