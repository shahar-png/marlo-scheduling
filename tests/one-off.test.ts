import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  createOneOffMeeting,
  getOneOffMeeting,
  resetOneOffMeetings,
} from '../lib/availability/one-off';
import { listAvailableTimes } from '../lib/availability/slots';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { CalendarProvider } from '../lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';

function emptyBusyProvider(): CalendarProvider {
  return {
    async freeBusy() {
      return [];
    },
    async createEvent() {
      return { id: 'mock-unused' };
    },
    async updateEvent() {
      return { id: 'mock-unused' };
    },
    async deleteEvent() {},
  };
}

describe('AC-1 one-off meeting stub', () => {
  beforeEach(() => {
    resetOneOffMeetings();
  });

  it('creates and reads a one-off meeting with IANA timezone and date windows', () => {
    const created = createOneOffMeeting({
      hostId: 'host-1',
      name: 'Board offsite',
      durationMinutes: 30,
      timezone: 'UTC',
      windows: [
        { date: '2026-09-20', start: '09:00', end: '12:00' },
        { date: '2026-09-21', start: '13:00', end: '15:00' },
      ],
    });

    assert.equal(created.hostId, 'host-1');
    assert.equal(created.name, 'Board offsite');
    assert.equal(created.durationMinutes, 30);
    assert.equal(created.timezone, 'UTC');
    assert.deepEqual(created.windows, [
      { date: '2026-09-20', start: '09:00', end: '12:00' },
      { date: '2026-09-21', start: '13:00', end: '15:00' },
    ]);
    assert.ok(created.id);
    assert.deepEqual(getOneOffMeeting(created.id), created);
  });

  it('rejects an empty timezone', () => {
    assert.throws(
      () =>
        createOneOffMeeting({
          hostId: 'host-1',
          name: 'Offsite',
          durationMinutes: 30,
          timezone: '   ',
          windows: [{ date: '2026-09-20', start: '09:00', end: '12:00' }],
        }),
      /timezone is required/,
    );
  });

  it('rejects empty windows', () => {
    assert.throws(
      () =>
        createOneOffMeeting({
          hostId: 'host-1',
          name: 'Offsite',
          durationMinutes: 30,
          timezone: 'UTC',
          windows: [],
        }),
      /windows must not be empty/,
    );
  });

  it('rejects an invalid date and start >= end', () => {
    assert.throws(
      () =>
        createOneOffMeeting({
          hostId: 'host-1',
          name: 'Offsite',
          durationMinutes: 30,
          timezone: 'UTC',
          windows: [{ date: '2026-09-31', start: '09:00', end: '12:00' }],
        }),
      /window date must be YYYY-MM-DD/,
    );
    assert.throws(
      () =>
        createOneOffMeeting({
          hostId: 'host-1',
          name: 'Offsite',
          durationMinutes: 30,
          timezone: 'UTC',
          windows: [{ date: '2026-09-20', start: '12:00', end: '09:00' }],
        }),
      /window start must be before end/,
    );
  });

  it('returns null when the meeting id is unknown', () => {
    assert.equal(getOneOffMeeting('missing'), null);
  });
});

describe('AC-3 one-off available times', () => {
  beforeEach(() => {
    resetOneOffMeetings();
  });

  it('returns duration-aligned ISO starts inside one-off windows (UTC)', async () => {
    const meeting = createOneOffMeeting({
      hostId: 'host-1',
      name: 'Offsite',
      durationMinutes: 30,
      timezone: 'UTC',
      windows: [{ date: '2026-09-20', start: '09:00', end: '12:00' }],
    });

    const times = await listAvailableTimes({
      eventType: { durationMinutes: meeting.durationMinutes },
      oneOffMeeting: meeting,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider: emptyBusyProvider(),
      calendarId: 'primary',
    });

    assert.deepEqual(times, [
      '2026-09-20T09:00:00.000Z',
      '2026-09-20T09:30:00.000Z',
      '2026-09-20T10:00:00.000Z',
      '2026-09-20T10:30:00.000Z',
      '2026-09-20T11:00:00.000Z',
      '2026-09-20T11:30:00.000Z',
    ]);
  });

  it('omits slots that overlap google-freebusy.json and keeps remaining one-off hours', async () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
        'utf8',
      ),
    ) as GoogleFreeBusyFixture;
    const meeting = createOneOffMeeting({
      hostId: 'host-1',
      name: 'Offsite',
      durationMinutes: 30,
      timezone: 'UTC',
      windows: [{ date: '2026-09-20', start: '09:00', end: '20:00' }],
    });

    const times = await listAvailableTimes({
      eventType: { durationMinutes: meeting.durationMinutes },
      oneOffMeeting: meeting,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider: createFixtureCalendarProvider(fixture),
      calendarId: 'primary',
    });

    assert.ok(times.includes('2026-09-20T09:00:00.000Z'));
    assert.ok(times.includes('2026-09-20T15:00:00.000Z'));
    assert.ok(!times.includes('2026-09-20T14:00:00.000Z'));
    assert.ok(!times.includes('2026-09-20T14:30:00.000Z'));
    assert.ok(!times.includes('2026-09-20T18:30:00.000Z'));

    const expected = [
      '2026-09-20T09:00:00.000Z',
      '2026-09-20T09:30:00.000Z',
      '2026-09-20T10:00:00.000Z',
      '2026-09-20T10:30:00.000Z',
      '2026-09-20T11:00:00.000Z',
      '2026-09-20T11:30:00.000Z',
      '2026-09-20T12:00:00.000Z',
      '2026-09-20T12:30:00.000Z',
      '2026-09-20T13:00:00.000Z',
      '2026-09-20T13:30:00.000Z',
      '2026-09-20T15:00:00.000Z',
      '2026-09-20T15:30:00.000Z',
      '2026-09-20T16:00:00.000Z',
      '2026-09-20T16:30:00.000Z',
      '2026-09-20T17:00:00.000Z',
      '2026-09-20T17:30:00.000Z',
      '2026-09-20T18:00:00.000Z',
      '2026-09-20T19:00:00.000Z',
      '2026-09-20T19:30:00.000Z',
    ];
    assert.deepEqual(times, expected);
  });
});
