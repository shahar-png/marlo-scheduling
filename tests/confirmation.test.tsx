import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConfirmationPage from '../app/(public)/b/[token]/page';
import { GET as bookingGET } from '../app/api/bookings/[id]/route';
import { getBookingByToken } from '../lib/api/server';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { bookAvailableSlot, resetBookings } from '../lib/booking/booking';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { t } from '../lib/copy';

const ROOT = process.cwd();
const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/google-freebusy.json'), 'utf8'),
) as GoogleFreeBusyFixture;

async function renderConfirmation(token: string): Promise<string> {
  const element = await ConfirmationPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(element);
}

describe('AC-5 confirmation route /b/{token}', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetCalendarConnections();
  });

  it('renders the branded shell with copy.confirmation.headline for an unknown token', async () => {
    const html = await renderConfirmation('missing-token');
    assert.ok(html.includes(t('confirmation.headline')));
    assert.match(html, /data-surface="lime"/);
    assert.match(html, /data-logo="wordmark"/);
    assert.match(html, /data-logo="mark"/);
    assert.match(html, /marlo-panel/);
    assert.ok(html.includes(t('brand.poweredBy')));
    assert.match(html, /data-confirmation-token="missing-token"/);
  });

  it('substitutes host/email in confirmation.subhead when the booking row exists', async () => {
    const schedule = createAvailabilitySchedule({
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
    });
    const eventType = createEventType({
      hostId: 'host-1',
      slug: 'intro-30',
      name: 'Intro call',
      durationMinutes: 30,
      availabilityScheduleId: schedule.id,
      kind: 'one_on_one',
    });
    const booking = await bookAvailableSlot({
      eventType,
      start: '2026-09-20T09:00:00.000Z',
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    assert.equal(getBookingByToken(booking.id)?.token, booking.id);
    const html = await renderConfirmation(booking.id);
    assert.ok(html.includes(t('confirmation.headline')));
    assert.ok(html.includes('ada@example.com'));
    assert.ok(html.includes(t('confirmation.with')));

    const response = await bookingGET(new Request(`http://localhost/api/bookings/${booking.id}`), {
      params: Promise.resolve({ id: booking.id }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { booking: { id: string } };
    assert.equal(body.booking.id, booking.id);

    const missing = await bookingGET(new Request('http://localhost/api/bookings/nope'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    assert.equal(missing.status, 404);
  });

  it('page source has no hard-coded "Handled." and reads copy through t()', () => {
    const source = readFileSync(
      path.join(ROOT, 'app/(public)/b/[token]/page.tsx'),
      'utf8',
    );
    assert.doesNotMatch(source, /Handled\./);
    assert.match(source, /confirmation\.headline/);
    assert.doesNotMatch(source, /\bfetch\(/);
  });
});
