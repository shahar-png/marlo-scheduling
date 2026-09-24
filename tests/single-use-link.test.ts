import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
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
import { bookSingleUseLink, resetBookings } from '../lib/booking/booking';
import {
  IdempotencyKeyReusedError,
  SlotUnavailableError,
} from '../lib/booking/errors';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { createHarness, teardown, type Harness } from './support/harness';

const FIXTURE = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
    'utf8',
  ),
) as GoogleFreeBusyFixture;

// The booking cases run on the harness clock (Monday 2026-09-21T09:00Z), so
// their fixtures and slots live on that day; the pure link-registry cases above
// never look at a clock.
const LINK_DATE = '2026-09-21';
const LINK_SLOT = '2026-09-21T10:00:00.000Z';
const LINK_SLOT_END = '2026-09-21T10:30:00.000Z';
const LINK_SLOT_LATER = '2026-09-21T11:00:00.000Z';

function seedIntro30() {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    // Monday, the weekday the harness clock sits on.
    windows: [{ weekday: 1, start: '09:00', end: '20:00' }],
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
    windows: [{ date: LINK_DATE, start: '09:00', end: '20:00' }],
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

// C10 — a link booking is a **shared** C6 create now, so these run against the
// real runtime: the durable store whose occupancy it shares with the
// owner-scoped route, the mock calendar the lifecycle owns, and a pinned clock
// (a start that has already elapsed is never on offer). The caller-supplied
// `provider` no longer reaches the calendar; it survives only on the
// available-times path.
describe('AC-4 book through unused single-use link consumes it', () => {
  let harness: Harness;

  beforeEach(() => {
    resetOneOffMeetings();
    resetSingleUseLinks();
    resetBookings();
    harness = createHarness('memory');
  });

  afterEach(() => {
    teardown();
  });

  it('confirms a booking on an event-type link and marks the link consumed', async () => {
    const eventType = seedIntro30();
    const link = createSingleUseLink({
      eventTypeId: eventType.id,
      token: 'use-once',
    });

    const outcome = await bookSingleUseLink({
      token: link.token,
      start: LINK_SLOT,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    assert.equal(outcome.envelope.booking.status, 'confirmed');
    assert.equal(outcome.envelope.booking.start, LINK_SLOT);
    assert.equal(outcome.envelope.booking.end, LINK_SLOT_END);
    // Exactly one calendar event, created by the lifecycle (C6.4), not by the
    // link path calling the provider itself.
    assert.equal(harness.calendar.liveEvents().length, 1);

    const consumed = getSingleUseLinkByToken('use-once');
    assert.equal(consumed?.status, LINK_CONSUMED);
    assert.equal(consumed?.consumedByBookingId, outcome.row.id);
    assert.equal(consumed?.bookingId, outcome.row.id);
  });

  it('confirms a booking on a one-off link and consumes the token', async () => {
    const meeting = seedOffsite();
    const link = createSingleUseLink({
      oneOffMeetingId: meeting.id,
      token: 'off-once',
    });

    const outcome = await bookSingleUseLink({
      token: link.token,
      start: LINK_SLOT,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    assert.equal(outcome.envelope.booking.status, 'confirmed');
    assert.equal(outcome.envelope.booking.start, LINK_SLOT);
    const consumed = getSingleUseLinkByToken('off-once');
    assert.equal(consumed?.status, LINK_CONSUMED);
    assert.equal(consumed?.consumedByBookingId, outcome.row.id);
  });

  it('does not consume the link on a slot conflict held by another booking', async () => {
    // The point of the shared path: occupancy written by *any* route for this
    // host blocks the link, and a refused link stays spendable.
    const meeting = seedOffsite();
    createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'taken-first' });
    createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'still-open' });

    await bookSingleUseLink({
      token: 'taken-first',
      start: LINK_SLOT,
      invitee: { name: 'Grace', email: 'grace@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    await assert.rejects(
      () =>
        bookSingleUseLink({
          token: 'still-open',
          start: LINK_SLOT,
          invitee: { name: 'Ada', email: 'ada@example.com' },
          provider: createFixtureCalendarProvider(FIXTURE),
          calendarId: 'primary',
        }),
      SlotUnavailableError,
    );

    assert.equal(getSingleUseLinkByToken('still-open')?.status, LINK_UNUSED);
  });

  it('replays the original booking when a consumed link is re-POSTed with the identical payload', async () => {
    const meeting = seedOffsite();
    createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'lost-201' });
    const payload = {
      token: 'lost-201',
      start: LINK_SLOT,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    };

    const first = await bookSingleUseLink(payload);
    // The client never saw the 201 and retries the same request.
    const replay = await bookSingleUseLink(payload);

    assert.equal(replay.replayed, true);
    assert.equal(replay.row.id, first.row.id);
    assert.equal(replay.envelope.booking.token, first.envelope.booking.token);
    // One booking, one calendar event — the retry inserted nothing.
    assert.equal(harness.calendar.liveEvents().length, 1);
    assert.equal(
      getSingleUseLinkByToken('lost-201')?.consumedByBookingId,
      first.row.id,
    );
  });

  it('refuses a consumed link whose payload differs', async () => {
    const meeting = seedOffsite();
    createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'spent' });

    await bookSingleUseLink({
      token: 'spent',
      start: LINK_SLOT,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    await assert.rejects(
      () =>
        bookSingleUseLink({
          token: 'spent',
          start: LINK_SLOT_LATER,
          invitee: { name: 'Grace', email: 'grace@example.com' },
          provider: createFixtureCalendarProvider(FIXTURE),
          calendarId: 'primary',
        }),
      IdempotencyKeyReusedError,
    );
  });
});
