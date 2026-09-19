import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import {
  connectHostCalendar,
  getHostCalendarConnection,
  resetCalendarConnections,
} from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { CalendarProvider } from '../lib/calendar/provider';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';

describe('AC-3 calendar-connection stub', () => {
  beforeEach(() => {
    resetCalendarConnections();
  });

  it('records connected status and a destination calendar id', () => {
    const created = connectHostCalendar('host-1', 'primary');
    assert.equal(created.hostId, 'host-1');
    assert.equal(created.connected, true);
    assert.equal(created.destinationCalendarId, 'primary');

    const read = getHostCalendarConnection('host-1');
    assert.deepEqual(read, created);
  });

  it('returns null when no connection has been recorded', () => {
    assert.equal(getHostCalendarConnection('missing-host'), null);
  });
});

describe('AC-4 CalendarProvider freeBusy adapter', () => {
  it('maps a checked-in Google freeBusy fixture to busy windows', async () => {
    const fixturePath = path.join(
      process.cwd(),
      'tests/fixtures/google-freebusy.json',
    );
    const fixture = JSON.parse(
      readFileSync(fixturePath, 'utf8'),
    ) as GoogleFreeBusyFixture;

    const provider: CalendarProvider = createFixtureCalendarProvider(fixture);
    const windows = await provider.freeBusy({
      calendarId: 'primary',
      timeMin: '2026-09-20T00:00:00.000Z',
      timeMax: '2026-09-21T00:00:00.000Z',
    });

    assert.equal(windows.length, 2);
    assert.deepEqual(windows[0], {
      start: '2026-09-20T14:00:00.000Z',
      end: '2026-09-20T15:00:00.000Z',
    });
    assert.deepEqual(windows[1], {
      start: '2026-09-20T18:30:00.000Z',
      end: '2026-09-20T19:00:00.000Z',
    });
  });

  it('records createEvent on the fixture adapter without live Google', async () => {
    const fixturePath = path.join(
      process.cwd(),
      'tests/fixtures/google-freebusy.json',
    );
    const fixture = JSON.parse(
      readFileSync(fixturePath, 'utf8'),
    ) as GoogleFreeBusyFixture;
    const provider = createFixtureCalendarProvider(fixture);
    const created = await provider.createEvent({
      calendarId: 'primary',
      start: '2026-09-20T09:00:00.000Z',
      end: '2026-09-20T09:30:00.000Z',
      summary: 'Intro call',
      attendees: [{ email: 'ada@example.com', displayName: 'Ada' }],
    });
    assert.match(created.id, /^mock-event-/);
    assert.equal(provider.createdEvents.length, 1);
    assert.equal(provider.createdEvents[0]?.id, created.id);
  });
});
