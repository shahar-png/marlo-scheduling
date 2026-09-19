import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { listAvailableTimes } from '../lib/availability/slots';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { CalendarProvider } from '../lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';

function emptyBusyProvider(): CalendarProvider {
  return {
    async freeBusy() {
      return [];
    },
  };
}

function sundaySchedule(timezone = 'UTC') {
  resetAvailabilitySchedules();
  return createAvailabilitySchedule({
    hostId: 'host-1',
    timezone,
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
}

function thirtyMinuteIntro(scheduleId: string) {
  resetEventTypes();
  return createEventType({
    hostId: 'host-1',
    slug: 'intro-30',
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: scheduleId,
    kind: 'one_on_one',
  });
}

describe('AC-3 listAvailableTimes with no busy windows', () => {
  it('returns duration-aligned ISO starts inside weekly hours (UTC)', async () => {
    resetAvailabilitySchedules();
    const schedule = createAvailabilitySchedule({
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [{ weekday: 0, start: '09:00', end: '12:00' }],
    });
    const eventType = thirtyMinuteIntro(schedule.id);

    const times = await listAvailableTimes({
      eventType,
      schedule,
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

  it('interprets weekly hours in the schedule IANA timezone', async () => {
    const schedule = sundaySchedule('America/New_York');
    resetEventTypes();
    const eventType = createEventType({
      hostId: 'host-1',
      slug: 'intro-60',
      name: 'Hour',
      durationMinutes: 60,
      availabilityScheduleId: schedule.id,
      kind: 'one_on_one',
    });

    const times = await listAvailableTimes({
      eventType,
      schedule: {
        ...schedule,
        windows: [{ weekday: 0, start: '09:00', end: '11:00' }],
      },
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider: emptyBusyProvider(),
      calendarId: 'primary',
    });

    // 2026-09-20 is EDT (UTC-4): 09:00–11:00 America/New_York = 13:00–15:00Z
    assert.deepEqual(times, [
      '2026-09-20T13:00:00.000Z',
      '2026-09-20T14:00:00.000Z',
    ]);
  });
});

describe('AC-4 listAvailableTimes subtracts fixture busy windows', () => {
  it('omits slots that overlap google-freebusy.json and keeps remaining weekly hours', async () => {
    const fixture = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'tests/fixtures/google-freebusy.json'),
        'utf8',
      ),
    ) as GoogleFreeBusyFixture;
    const provider = createFixtureCalendarProvider(fixture);
    const schedule = sundaySchedule('UTC');
    const eventType = thirtyMinuteIntro(schedule.id);

    const times = await listAvailableTimes({
      eventType,
      schedule,
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
      provider,
      calendarId: 'primary',
    });

    assert.ok(times.includes('2026-09-20T09:00:00.000Z'));
    assert.ok(times.includes('2026-09-20T13:30:00.000Z'));
    assert.ok(times.includes('2026-09-20T15:00:00.000Z'));
    assert.ok(times.includes('2026-09-20T18:00:00.000Z'));
    assert.ok(times.includes('2026-09-20T19:00:00.000Z'));
    assert.ok(times.includes('2026-09-20T19:30:00.000Z'));

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
