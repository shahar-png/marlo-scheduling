import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ConfirmationPage from '../app/(public)/b/[token]/page';
import { isValidEmail } from '../app/(public)/[slug]/[event]/booking-form-store';
import { GET as bookingGET } from '../app/api/bookings/[id]/route';
import { publicBookingPath } from '../lib/api/public-path';
import { getBookingByToken } from '../lib/api/server';
import {
  createEventType,
  getEventType,
  getEventTypeBySlug,
  resetEventTypes,
} from '../lib/availability/event-type';
import { createOneOffMeeting, resetOneOffMeetings } from '../lib/availability/one-off';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { createSingleUseLink, resetSingleUseLinks } from '../lib/availability/single-use-link';
import {
  BOOKING_CANCELLED,
  BOOKING_CONFIRMED,
  bookAvailableSlot,
  bookSingleUseLink,
  cancelBooking,
  getBooking,
  resetBookings,
} from '../lib/booking/booking';
import { connectHostCalendar, resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { t } from '../lib/copy';
import { DEMO_HOST_ID, ensureDemoFixtures, hostMetaForHostId } from '../lib/demo/seed';

const ROOT = process.cwd();
const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/google-freebusy.json'), 'utf8'),
) as GoogleFreeBusyFixture;
const COPY = JSON.parse(readFileSync(path.join(ROOT, 'copy/en.json'), 'utf8')) as {
  brand: { poweredBy: string };
  states: { notFound: string };
  cancel: { bookAgain: string };
  confirmation: { headline: string; with: string; where: string };
};

const SLOT_0900 = '2026-09-20T09:00:00.000Z';

// react-dom/server escapes `'` as &#x27; in text nodes.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

// BOOK-FE-15: the expected host name comes from the canonical resolver, not
// from importing DEMO_HOST_FIRST_NAME into the page.
const HOST_FIRST_NAME = hostMetaForHostId(DEMO_HOST_ID)!.firstName;
const SUBHEAD = escapeHtml(
  t('confirmation.subhead', {
    hostFirstName: HOST_FIRST_NAME,
    inviteeEmail: 'ada@example.com',
  }),
);
const CANCEL_DONE = t('cancel.done', { hostFirstName: HOST_FIRST_NAME });
const BOOK_AGAIN = t('cancel.bookAgain');
const NOT_FOUND = t('states.notFound');
const POWERED_BY = escapeHtml(t('brand.poweredBy'));
// The confirmed page's when-line (UTC, "Sunday, September 20 at 9:00 AM UTC").
const WHEN_TEXT = 'September 20';

async function renderConfirmation(token: string): Promise<string> {
  const element = await ConfirmationPage({ params: Promise.resolve({ token }) });
  return renderToStaticMarkup(element);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]);
}

function seedIntro30(hostId = 'host-1', slug = 'intro-30') {
  const schedule = createAvailabilitySchedule({
    hostId,
    timezone: 'UTC',
    windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
  });
  return createEventType({
    hostId,
    slug,
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

// Shared lime-shell + cancelled-copy assertions for the "no link" cancelled
// rows (one-off, unrepresentable slug).
function assertCancelledShellWithoutLink(html: string, forbiddenHrefFragments: string[]) {
  assert.ok(html.includes(CANCEL_DONE));
  assert.equal(html.includes(BOOK_AGAIN), false);
  assert.doesNotMatch(html, /data-book-again/);
  for (const href of hrefs(html)) {
    for (const fragment of forbiddenHrefFragments) {
      assert.equal(href.includes(fragment), false, `href ${href} contains ${fragment}`);
    }
    assert.notEqual(href, '#');
  }
  assert.equal(html.includes(SUBHEAD), false);
  assert.equal(html.includes('ada@example.com'), false);
  assert.equal(html.includes(WHEN_TEXT), false);
  assert.equal(html.includes(t('confirmation.with')), false);
  assert.equal(html.includes(t('confirmation.where')), false);
  assert.equal(html.includes(t('confirmation.headline')), false);
  assert.match(html, /data-surface="lime"/);
  assert.match(html, /data-logo="wordmark"/);
  assert.match(html, /data-logo="mark"/);
  assert.ok(html.includes(POWERED_BY));
}

// AC-10 (f): the unsupported-host shell — brand present, host attribution
// absent. Not a blanket `Marlo` ban (BOOK-FE-18).
function assertUnsupportedHostShell(
  html: string,
  booking: { eventTypeId: string; invitee: { email: string } },
) {
  assert.ok(html.includes(NOT_FOUND));
  assert.match(html, /data-logo="wordmark"/);
  assert.match(html, /data-logo="mark"/);
  assert.ok(html.includes(POWERED_BY));
  assert.ok(html.includes('Marlo'), 'branding keeps the product name');

  // No host-bearing copy, substituted with any name.
  assert.equal(html.includes(COPY.confirmation.headline), false);
  assert.equal(html.includes(SUBHEAD), false);
  assert.equal(html.includes(escapeHtml("'s calendar.")), false);
  assert.equal(html.includes(escapeHtml("Invite's on its way to")), false);
  assert.equal(html.includes(booking.invitee.email), false);
  assert.equal(html.includes('Canceled.'), false);
  assert.equal(html.includes('knows.'), false);
  assert.equal(html.includes(BOOK_AGAIN), false);
  assert.equal(html.includes(WHEN_TEXT), false);
  assert.equal(html.includes('9:00'), false);
  assert.equal(html.includes(COPY.confirmation.with), false);
  assert.equal(html.includes(COPY.confirmation.where), false);
  assert.doesNotMatch(html, /<dl[\s>]/);
  assert.doesNotMatch(html, /<dd[\s>]/);
  for (const href of hrefs(html)) {
    assert.equal(href.includes('/demo/'), false, `href ${href}`);
    assert.equal(href.includes('intro-b'), false, `href ${href}`);
    assert.equal(href.includes(booking.eventTypeId), false, `href ${href}`);
  }
  // Brand-scoped name check: `Marlo` survives only inside the Logo <svg>
  // element(s) and the brand.poweredBy text.
  const stripped = html.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(POWERED_BY, '');
  assert.equal(stripped.includes('Marlo'), false, stripped);
}

// Stylesheet model shared by (e′) and (i): every @media block by brace
// matching (as [start, end) offsets), the 768px block carrying the 64px hero
// rule, and an `insideMedia` predicate for the non-media rule walk. Comments
// are blanked (length-preserving) before the rule regex so a comment that
// mentions a class or a declaration can never pose as one.
function stylesheetModel(css: string) {
  const blanked = css.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const mediaRanges: Array<{ start: number; end: number; body: string }> = [];
  let from = 0;
  for (;;) {
    const at = blanked.indexOf('@media', from);
    if (at < 0) break;
    const open = blanked.indexOf('{', at);
    let depth = 0;
    let close = open;
    for (let i = open; i < blanked.length; i += 1) {
      if (blanked[i] === '{') depth += 1;
      if (blanked[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    mediaRanges.push({ start: at, end: close + 1, body: blanked.slice(open + 1, close) });
    from = close + 1;
  }
  const mobile = mediaRanges.find(
    (range) =>
      blanked.slice(range.start, range.start + 30).includes('(max-width: 768px)') &&
      /\.marlo-display--hero\s*\{[^}]*font-size:\s*var\(--display-hero-mobile\)/.test(range.body),
  );
  assert.ok(mobile, 'a @media (max-width: 768px) block carries the 64px hero rule');
  const insideMedia = (offset: number) =>
    mediaRanges.some((range) => offset >= range.start && offset < range.end);
  // Non-media rules with their offsets and trimmed selectors.
  const rules: Array<{ offset: number; selector: string; body: string }> = [];
  for (const m of blanked.matchAll(/([^{}@]+?)\{([^{}]*)\}/g)) {
    const offset = m.index ?? -1;
    if (offset < 0 || insideMedia(offset)) continue;
    rules.push({ offset, selector: m[1].trim(), body: m[2] });
  }
  return { blanked, mediaRanges, mobile, mobileStart: mobile.start, insideMedia, rules };
}

describe('AC-5 confirmation route /b/{token}', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
    resetOneOffMeetings();
    resetSingleUseLinks();
    resetCalendarConnections();
  });

  it('(c) renders the branded shell with copy.confirmation.headline for an unknown token', async () => {
    assert.equal(getBookingByToken('missing-token'), null);
    const html = await renderConfirmation('missing-token');
    assert.ok(html.includes(t('confirmation.headline')));
    assert.match(html, /data-surface="lime"/);
    assert.match(html, /data-logo="wordmark"/);
    assert.match(html, /data-logo="mark"/);
    assert.match(html, /marlo-panel/);
    assert.ok(html.includes(POWERED_BY));
    assert.match(html, /data-confirmation-token="missing-token"/);
    assert.equal(html.includes('ada@example.com'), false);
    assert.equal(html.includes(CANCEL_DONE), false);
    assert.equal(html.includes(NOT_FOUND), false);
    assert.equal(html.includes(t('confirmation.with')), false);
  });

  it('(a) confirmed: substitutes host/email in confirmation.subhead, shows the details, carries bookAgainHref but renders no anchor (BOOK-FE-20)', async () => {
    const eventType = seedIntro30();
    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });

    const row = getBookingByToken(booking.id);
    assert.equal(row?.kind, 'booking');
    assert.ok(row && row.kind === 'booking');
    assert.equal(row.token, booking.id);
    assert.equal(row.status, BOOKING_CONFIRMED);
    assert.equal(row.hostFirstName, HOST_FIRST_NAME);
    assert.equal(row.hostFirstName, 'Marlo');
    // BOOK-FE-20: the field is a fact about resolvability, not status.
    assert.equal(row.bookAgainHref, '/demo/intro-30');

    const html = await renderConfirmation(booking.id);
    assert.ok(html.includes(t('confirmation.headline')));
    assert.ok(html.includes(SUBHEAD));
    assert.ok(html.includes(t('confirmation.with')));
    assert.ok(html.includes(t('confirmation.where')));
    assert.ok(html.includes(WHEN_TEXT));
    assert.equal(html.includes(CANCEL_DONE), false);
    assert.equal(html.includes(BOOK_AGAIN), false);
    assert.doesNotMatch(html, /data-book-again/);
    assert.equal(hrefs(html).some((href) => href.includes('/demo/')), false);
    assert.match(html, /data-booking-status="confirmed"/);
    assert.match(html, /<h1 class="marlo-display marlo-display--hero">/);

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

  it('(b) BOOK-FE-11 cancelled through the existing cancelBooking: cancel.done + bookAgain link, nothing active', async () => {
    const eventType = seedIntro30();
    const provider = createFixtureCalendarProvider(FIXTURE);
    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    await cancelBooking({
      bookingId: booking.id,
      reason: 'cannot make it',
      provider,
      calendarId: 'primary',
    });
    assert.equal(getBooking(booking.id)?.status, BOOKING_CANCELLED);

    const row = getBookingByToken(booking.id);
    assert.ok(row && row.kind === 'booking');
    assert.equal(row.status, BOOKING_CANCELLED);
    assert.equal(row.hostFirstName, 'Marlo');
    // Built from the same HostMeta.slug through publicBookingPath.
    assert.equal(row.bookAgainHref, '/demo/intro-30');
    assert.equal(
      row.bookAgainHref,
      publicBookingPath(hostMetaForHostId(DEMO_HOST_ID)!.slug, eventType.slug),
    );

    const html = await renderConfirmation(booking.id);
    assert.ok(html.includes(CANCEL_DONE));
    assert.ok(html.includes(BOOK_AGAIN));
    assert.match(html, /<a[^>]*href="\/demo\/intro-30"[^>]*>/);
    assert.match(html, /data-book-again="true"/);
    assert.equal(html.includes(SUBHEAD), false);
    assert.equal(html.includes('ada@example.com'), false);
    assert.equal(html.includes(WHEN_TEXT), false);
    assert.equal(html.includes('9:00'), false);
    assert.equal(html.includes(t('confirmation.with')), false);
    assert.equal(html.includes(t('confirmation.where')), false);
    assert.equal(html.includes(t('confirmation.headline')), false);
    assert.match(html, /data-surface="lime"/);
    assert.match(html, /data-logo="wordmark"/);
    assert.match(html, /data-logo="mark"/);
    assert.ok(html.includes(POWERED_BY));
    assert.match(html, /data-booking-status="cancelled"/);
    assert.match(html, /<h1 class="marlo-display marlo-display--hero">/);
  });

  it("(b′) BOOK-FE-14 cancelled one-off booking (bookSingleUseLink): cancellation shell, no bookAgain link, no invented href", async () => {
    const meeting = seedOffsite();
    const link = createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'use-once' });
    const provider = createFixtureCalendarProvider(FIXTURE);
    const booking = await bookSingleUseLink({
      token: link.token,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    // Precondition the fallback exists for: the synthetic one-off event type
    // is not in the store. If this ever fails, the fallback is unreachable.
    assert.equal(getEventType(booking.eventTypeId), null);
    assert.equal(booking.eventTypeId, meeting.id);

    await cancelBooking({
      bookingId: booking.id,
      reason: 'cannot make it',
      provider,
      calendarId: 'primary',
    });
    assert.equal(getBooking(booking.id)?.status, BOOKING_CANCELLED);

    const row = getBookingByToken(booking.id);
    assert.ok(row && row.kind === 'booking');
    assert.equal(row.status, BOOKING_CANCELLED);
    // Host resolved (host-1), event type not ⇒ name but no href.
    assert.equal(row.hostFirstName, 'Marlo');
    assert.equal(row.bookAgainHref, undefined);
    assert.equal('bookAgainHref' in row, false);

    let html = '';
    await assert.doesNotReject(async () => {
      html = await renderConfirmation(booking.id);
    });
    assertCancelledShellWithoutLink(html, ['one-off-', booking.eventTypeId, meeting.id]);
    assert.doesNotMatch(html, /one-off-/);
  });

  it('a confirmed one-off booking still renders the active layout without an event-type lookup', async () => {
    const meeting = seedOffsite();
    const link = createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'use-once' });
    const booking = await bookSingleUseLink({
      token: link.token,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider: createFixtureCalendarProvider(FIXTURE),
      calendarId: 'primary',
    });
    assert.equal(getEventType(booking.eventTypeId), null);
    const row = getBookingByToken(booking.id);
    assert.ok(row && row.kind === 'booking');
    assert.equal(row.status, BOOKING_CONFIRMED);
    assert.equal(row.hostFirstName, 'Marlo');
    assert.equal(row.bookAgainHref, undefined);
    const html = await renderConfirmation(booking.id);
    assert.ok(html.includes(SUBHEAD));
    assert.ok(html.includes(WHEN_TEXT));
    assert.equal(html.includes(CANCEL_DONE), false);
    assert.equal(html.includes(BOOK_AGAIN), false);
  });

  it('(f) BOOK-FE-17/18 unsupported host: a host-2 row booked through bookAvailableSlot renders states.notFound, confirmed and cancelled', async () => {
    // Fixture shape from tests/collective.test.ts — no host directory.
    const eventType = seedIntro30('host-2', 'intro-b');
    connectHostCalendar('host-2', 'host-2-cal');
    // Precondition this case exists for: host-2 is not a canonical host.
    assert.equal(hostMetaForHostId('host-2'), null);

    const provider = createFixtureCalendarProvider(FIXTURE);
    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'host-2-cal',
    });
    assert.equal(booking.hostId, 'host-2');

    // (i) confirmed
    const confirmedResult = getBookingByToken(booking.id);
    assert.ok(confirmedResult);
    assert.equal(confirmedResult.kind, 'unsupported_host');
    assert.equal('hostFirstName' in confirmedResult, false);
    assert.equal('bookAgainHref' in confirmedResult, false);
    assert.equal((confirmedResult as { hostFirstName?: string }).hostFirstName, undefined);
    assert.equal((confirmedResult as { bookAgainHref?: string }).bookAgainHref, undefined);
    assert.equal('status' in confirmedResult, false);
    assert.equal('start' in confirmedResult, false);
    assert.equal('invitee' in confirmedResult, false);
    assert.deepEqual(Object.keys(confirmedResult), ['kind']);

    let html = '';
    await assert.doesNotReject(async () => {
      html = await renderConfirmation(booking.id);
    });
    assertUnsupportedHostShell(html, booking);

    // (ii) cancelled — the same shell, not cancel.done
    await cancelBooking({
      bookingId: booking.id,
      reason: 'cannot make it',
      provider,
      calendarId: 'host-2-cal',
    });
    assert.equal(getBooking(booking.id)?.status, BOOKING_CANCELLED);

    const cancelledResult = getBookingByToken(booking.id);
    assert.ok(cancelledResult);
    assert.equal(cancelledResult.kind, 'unsupported_host');
    assert.deepEqual(Object.keys(cancelledResult), ['kind']);

    let cancelledHtml = '';
    await assert.doesNotReject(async () => {
      cancelledHtml = await renderConfirmation(booking.id);
    });
    assertUnsupportedHostShell(cancelledHtml, booking);
  });

  it('(f)(iii) BOOK-FE-20 discriminant matrix: bookAgainHref by resolvability, never by status', async () => {
    const provider = createFixtureCalendarProvider(FIXTURE);
    const eventType = seedIntro30();

    // (a) confirmed demo row
    const confirmed = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    const a = getBookingByToken(confirmed.id);
    assert.ok(a && a.kind === 'booking');
    assert.equal(a.status, BOOKING_CONFIRMED);
    assert.equal(a.hostFirstName, 'Marlo');
    assert.equal(a.bookAgainHref, '/demo/intro-30');

    // (b) cancelled demo row
    const cancelledDemo = await bookAvailableSlot({
      eventType,
      start: '2026-09-20T10:00:00.000Z',
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    await cancelBooking({ bookingId: cancelledDemo.id, reason: 'x', provider, calendarId: 'primary' });
    const b = getBookingByToken(cancelledDemo.id);
    assert.ok(b && b.kind === 'booking');
    assert.equal(b.status, BOOKING_CANCELLED);
    assert.equal(b.hostFirstName, 'Marlo');
    assert.equal(b.bookAgainHref, '/demo/intro-30');

    // (b′) cancelled one-off row — host resolved, event type not
    const meeting = seedOffsite();
    const link = createSingleUseLink({ oneOffMeetingId: meeting.id, token: 'use-once' });
    const oneOff = await bookSingleUseLink({
      token: link.token,
      start: '2026-09-20T11:00:00.000Z',
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });
    await cancelBooking({ bookingId: oneOff.id, reason: 'x', provider, calendarId: 'primary' });
    const bPrime = getBookingByToken(oneOff.id);
    assert.ok(bPrime && bPrime.kind === 'booking');
    assert.equal(bPrime.status, BOOKING_CANCELLED);
    assert.equal(bPrime.hostFirstName, 'Marlo');
    assert.equal(bPrime.bookAgainHref, undefined);
  });

  it('(g) BOOK-FE-19 unrepresentable store slug (intro#follow-up): no bookAgainHref, cancelled shell without a link', async () => {
    const eventType = seedIntro30('host-1', 'intro#follow-up');
    // Preconditions this case exists for: the store accepts the slug, the
    // constructor rejects it.
    assert.ok(getEventTypeBySlug('intro#follow-up'));
    assert.equal(publicBookingPath('demo', 'intro#follow-up'), null);

    const provider = createFixtureCalendarProvider(FIXTURE);
    const booking = await bookAvailableSlot({
      eventType,
      start: SLOT_0900,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      provider,
      calendarId: 'primary',
    });

    // (g-1) confirmed
    const confirmed = getBookingByToken(booking.id);
    assert.ok(confirmed && confirmed.kind === 'booking');
    assert.equal(confirmed.hostFirstName, 'Marlo');
    assert.equal(confirmed.bookAgainHref, undefined);
    assert.equal('bookAgainHref' in confirmed, false);

    // (g-2) cancelled
    await cancelBooking({ bookingId: booking.id, reason: 'x', provider, calendarId: 'primary' });
    assert.equal(getBooking(booking.id)?.status, BOOKING_CANCELLED);
    const cancelled = getBookingByToken(booking.id);
    assert.ok(cancelled && cancelled.kind === 'booking');
    assert.equal(cancelled.bookAgainHref, undefined);

    let html = '';
    await assert.doesNotReject(async () => {
      html = await renderConfirmation(booking.id);
    });
    assertCancelledShellWithoutLink(html, ['follow-up', '#', booking.eventTypeId]);
  });

  it('(d) page source has no literal "Handled." or "Canceled.", no demo constants, and branches on the discriminant', () => {
    const source = readFileSync(
      path.join(ROOT, 'app/(public)/b/[token]/page.tsx'),
      'utf8',
    );
    assert.doesNotMatch(source, /Handled\./);
    assert.doesNotMatch(source, /Canceled\./);
    assert.doesNotMatch(source, /Cancelled\./);
    assert.match(source, /confirmation\.headline/);
    assert.match(source, /cancel\.done/);
    assert.match(source, /cancel\.bookAgain/);
    assert.match(source, /states\.notFound/);
    assert.match(source, /unsupported_host/);
    assert.match(source, /BOOKING_CONFIRMED/);
    assert.match(source, /BOOKING_CANCELLED/);
    assert.doesNotMatch(source, /'cancelled'/);
    assert.doesNotMatch(source, /'confirmed'/);
    assert.doesNotMatch(source, /getEventType/);
    assert.doesNotMatch(source, /one-off/);
    assert.doesNotMatch(source, /\bfetch\(/);
    // BOOK-FE-15/17: no demo constants; the name comes from the adapter row.
    assert.doesNotMatch(source, /DEMO_HOST_FIRST_NAME/);
    assert.doesNotMatch(source, /DEMO_HOST_SLUG/);
    assert.match(source, /booking\.hostFirstName/);
  });

  it('(h) BOOK-FE-20 anchor-by-branch: cancel.bookAgain occurs once, bookAgainHref only inside the cancelled component', () => {
    const source = readFileSync(
      path.join(ROOT, 'app/(public)/b/[token]/page.tsx'),
      'utf8',
    );
    assert.equal(source.split('cancel.bookAgain').length - 1, 1);
    // The cancelled branch is a separate function; slice it out by name.
    const start = source.indexOf('function CancelledPanel');
    assert.ok(start > 0);
    const end = source.indexOf('\nfunction ', start + 1);
    assert.ok(end > start);
    const cancelledBranch = source.slice(start, end);
    const outside = source.slice(0, start) + source.slice(end);
    assert.ok(cancelledBranch.includes('bookAgainHref'));
    assert.ok(cancelledBranch.includes('cancel.bookAgain'));
    assert.equal(outside.includes('bookAgainHref'), false);
    assert.equal(outside.includes('cancel.bookAgain'), false);
    // The confirmed branch does not reference the field.
    const confirmedStart = source.indexOf('function ConfirmedPanel');
    const confirmedEnd = source.indexOf('\nfunction ', confirmedStart + 1);
    assert.equal(source.slice(confirmedStart, confirmedEnd).includes('bookAgainHref'), false);
  });

  it('(f)(iv) BOOK-FE-17 source: the adapter module has no demo-name fallback', () => {
    const source = readFileSync(path.join(ROOT, 'lib/api/server.ts'), 'utf8');
    assert.doesNotMatch(source, /DEMO_HOST_FIRST_NAME/);
    assert.doesNotMatch(source, /\?\?\s*['"]/);
    assert.doesNotMatch(source, /hostFirstName\s*[:=]\s*['"]/);
    assert.doesNotMatch(source, /\|\|\s*['"]/);
    assert.match(source, /hostMetaForHostId/);
    assert.match(source, /unsupported_host/);
    // BOOK-FE-19: paths only through the constructor.
    assert.match(source, /import \{ publicBookingPath \} from '\.\/public-path'/);
    assert.doesNotMatch(source, /`\/\$\{/);
    assert.doesNotMatch(source, /\$\{eventType\.slug\}/);
    assert.doesNotMatch(source, /\$\{host\.slug\}/);
    assert.doesNotMatch(source, /DEMO_HOST_SLUG/);
  });

  it('(e) BOOK-FE-16 mobile hero: 64px under the 768px breakpoint, desktop rule unchanged, tokens untouched', () => {
    const css = readFileSync(path.join(ROOT, 'app/marlo-ui.css'), 'utf8');
    assert.match(css, /--display-hero-mobile:\s*64px/);

    // Brace-matching slice of every `@media (max-width: 768px)` block.
    const blocks: string[] = [];
    const marker = '@media (max-width: 768px)';
    let from = 0;
    for (;;) {
      const at = css.indexOf(marker, from);
      if (at < 0) break;
      const open = css.indexOf('{', at);
      let depth = 0;
      let close = open;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      blocks.push(css.slice(open, close + 1));
      from = close + 1;
    }
    assert.ok(blocks.length >= 1);
    const media = blocks.join('\n');
    assert.match(media, /\.marlo-display--hero\s*\{[^}]*font-size:\s*var\(--display-hero-mobile\)/);
    assert.match(media, /\.marlo-display--hero\s*\{[^}]*overflow-wrap:\s*anywhere/);
    assert.match(media, /\.marlo-display--hero\s*\{[^}]*min-width:\s*0/);
    assert.match(media, /\.marlo-panel\s*\{[^}]*var\(--s-5\)/);
    assert.match(media, /\.marlo-page\s*\{[^}]*var\(--s-4\)/);

    // The non-media hero rule still uses the desktop token.
    let outside = css;
    for (const block of blocks) {
      outside = outside.replace(block, '');
    }
    assert.match(outside, /\.marlo-display--hero\s*\{[^}]*font-size:\s*var\(--display-hero\)/);
    assert.doesNotMatch(outside, /\.marlo-display--hero\s*\{[^}]*hero-mobile/);

    const tokens = readFileSync(path.join(ROOT, 'app/tokens/marlo.css'), 'utf8');
    assert.doesNotMatch(tokens, /hero-mobile/);
    assert.match(tokens, /--display-hero:\s*112px/);
  });

  // Presence (e) is necessary but not sufficient: IMPL14 passed it with the
  // mobile block placed *before* the base rules, so the equally specific base
  // rules won and a 390px viewport still got the 112px hero. This is the text-
  // order model the browser uses — equal specificity, later source order wins.
  it('(e′) BOOK-FE-21 cascade order: the mobile block sits after every base hero/panel/page rule', () => {
    const css = readFileSync(path.join(ROOT, 'app/marlo-ui.css'), 'utf8');
    const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '');

    // (1) Every @media block by brace matching, as [start, end) offsets.
    const mediaRanges: Array<{ start: number; end: number; body: string }> = [];
    let from = 0;
    for (;;) {
      const at = css.indexOf('@media', from);
      if (at < 0) break;
      const open = css.indexOf('{', at);
      let depth = 0;
      let close = open;
      for (let i = open; i < css.length; i += 1) {
        if (css[i] === '{') depth += 1;
        if (css[i] === '}') {
          depth -= 1;
          if (depth === 0) {
            close = i;
            break;
          }
        }
      }
      mediaRanges.push({ start: at, end: close + 1, body: css.slice(open + 1, close) });
      from = close + 1;
    }
    const mobile = mediaRanges.find(
      (range) =>
        css.slice(range.start, range.start + 30).includes('(max-width: 768px)') &&
        /\.marlo-display--hero\s*\{[^}]*font-size:\s*var\(--display-hero-mobile\)/.test(range.body),
    );
    assert.ok(mobile, 'a @media (max-width: 768px) block carries the 64px hero rule');
    const mobileStart = mobile.start;
    const insideMedia = (offset: number) =>
      mediaRanges.some((range) => offset >= range.start && offset < range.end);

    // (2) Every non-media rule that sets hero font-size / panel padding / page
    // padding must precede the mobile block — and at least one of each exists.
    const heroOffsets: number[] = [];
    const panelOffsets: number[] = [];
    const pageOffsets: number[] = [];
    for (const m of css.matchAll(/([^{}@]+?)\{([^{}]*)\}/g)) {
      const offset = m.index ?? -1;
      if (offset < 0 || insideMedia(offset)) continue;
      const selector = stripComments(m[1]);
      const body = m[2];
      if (selector.includes('.marlo-display--hero') && /\bfont-size\s*:/.test(body)) {
        assert.match(body, /font-size:\s*var\(--display-hero\)/);
        heroOffsets.push(offset);
      }
      if (selector.includes('.marlo-panel') && /\bpadding\s*:/.test(body)) {
        panelOffsets.push(offset);
      }
      if (selector.includes('.marlo-page') && /\bpadding\s*:/.test(body)) {
        pageOffsets.push(offset);
      }
    }
    assert.ok(heroOffsets.length >= 1, 'a base .marlo-display--hero font-size rule exists');
    assert.ok(panelOffsets.length >= 1, 'a base .marlo-panel padding rule exists');
    assert.ok(pageOffsets.length >= 1, 'a base .marlo-page padding rule exists');
    for (const offset of [...heroOffsets, ...panelOffsets, ...pageOffsets]) {
      assert.ok(
        offset < mobileStart,
        `base rule at offset ${offset} must precede the mobile block at ${mobileStart}`,
      );
    }

    // (3) Inside the mobile block: bare single-class selectors only (no
    // descendant / compound / element-qualified selector) and no importance
    // flag anywhere in the file — the override wins by order alone.
    const mobileSelectors = new Map<string, string>();
    for (const m of mobile.body.matchAll(/([^{}]+?)\{([^{}]*)\}/g)) {
      mobileSelectors.set(stripComments(m[1]).trim(), m[2]);
    }
    for (const selector of ['.marlo-display--hero', '.marlo-panel', '.marlo-page']) {
      assert.ok(mobileSelectors.has(selector), `mobile block has a bare ${selector} rule`);
    }
    assert.match(mobileSelectors.get('.marlo-display--hero')!, /font-size:\s*var\(--display-hero-mobile\)/);
    assert.match(mobileSelectors.get('.marlo-panel')!, /padding:\s*var\(--s-8\)\s+var\(--s-5\)/);
    assert.match(mobileSelectors.get('.marlo-page')!, /padding:\s*var\(--s-6\)\s+var\(--s-4\)\s+var\(--s-10\)/);
    for (const selector of mobileSelectors.keys()) {
      assert.ok(
        selector.startsWith('.marlo-') && !/[\s>+~,\[:]/.test(selector),
        `mobile selector "${selector}" is a single bare class`,
      );
    }
    assert.equal(css.includes('!' + 'important'), false);
  });

  // The hero fix (e/e′) does not reach the subhead: it is a sibling <p> that
  // interpolates the invitee's email, and an address the form and the backend
  // both accept can carry a 64-character unbroken local part — wider than the
  // ≈318px a 390px panel leaves. Every other case books `ada@example.com`, so
  // the suite was green against the overflow. This is the only case that books
  // the long address; it ties the wrapping class to that email in the markup.
  it('(i) BOOK-FE-22 long accepted email: wraps inside <p class="marlo-panel__subhead"> — no inline style, no truncation, stylesheet rule above the mobile block', async () => {
    const LONG_LOCAL = 'a'.repeat(64);
    const LONG_EMAIL = `${LONG_LOCAL}@example.com`;
    // Preconditions: the real form's gate accepts it, and so does the service.
    assert.equal(isValidEmail(LONG_EMAIL), true);
    const eventType = ensureDemoFixtures();
    let booking!: Awaited<ReturnType<typeof bookAvailableSlot>>;
    await assert.doesNotReject(async () => {
      booking = await bookAvailableSlot({
        eventType,
        start: '2026-09-21T09:00:00.000Z', // Monday, inside the demo weekday schedule
        invitee: { name: 'Ada Lovelace', email: LONG_EMAIL },
        provider: createFixtureCalendarProvider(FIXTURE),
        calendarId: 'primary',
      });
    });
    const row = getBookingByToken(booking.id);
    assert.ok(row && row.kind === 'booking');
    assert.equal(row.invitee.email, LONG_EMAIL);
    assert.equal(row.status, BOOKING_CONFIRMED);

    const html = await renderConfirmation(booking.id);
    const expectedSubhead = escapeHtml(
      t('confirmation.subhead', { hostFirstName: HOST_FIRST_NAME, inviteeEmail: LONG_EMAIL }),
    );
    // (1) The substituted subhead with the long address sits inside the exact
    // `<p class="marlo-panel__subhead">` opening tag — which is also (2): that
    // tag carries no style= attribute.
    const m = html.match(/<p class="marlo-panel__subhead">([\s\S]*?)<\/p>/);
    assert.ok(m, 'subhead paragraph carries only the class');
    assert.ok(m[1].includes(LONG_EMAIL));
    assert.equal(m[1], expectedSubhead);
    assert.ok(html.includes(expectedSubhead));
    assert.doesNotMatch(html, /<p class="marlo-panel__subhead" style=/);
    assert.doesNotMatch(html, /<p style="[^"]*"[^>]*class="marlo-panel__subhead"/);
    // The (a) case's inline-size pattern is gone from the page markup.
    assert.doesNotMatch(html, /<p style="font-size:var\(--text-lg\)">/);
    // (3) The whole 64-character local part, never an ellipsis.
    assert.ok(html.includes(LONG_LOCAL + '@example.com'));
    assert.equal(html.includes('…'), false);
    assert.equal(html.includes('&hellip;'), false);
    assert.equal(html.includes('&#x2026;'), false);
    // Still the confirmed layout with the hero class (BOOK-FE-21 untouched).
    assert.match(html, /<h1 class="marlo-display marlo-display--hero">/);
    assert.match(html, /data-booking-status="confirmed"/);

    // Stylesheet assertions on app/marlo-ui.css, reusing the (e′) model.
    const css = readFileSync(path.join(ROOT, 'app/marlo-ui.css'), 'utf8');
    const model = stylesheetModel(css);

    // (4) A non-media rule whose trimmed selector is exactly
    // `.marlo-panel__subhead` declares the wrapping rule + width constraints
    // + the size the inline style used to set.
    const subheadRules = model.rules.filter((rule) => rule.selector === '.marlo-panel__subhead');
    assert.equal(subheadRules.length, 1, 'exactly one base .marlo-panel__subhead rule');
    const subhead = subheadRules[0];
    assert.match(subhead.body, /overflow-wrap:\s*anywhere\s*;/);
    assert.match(subhead.body, /min-width:\s*0\s*;/);
    assert.match(subhead.body, /max-width:\s*100%\s*;/);
    assert.match(subhead.body, /font-size:\s*var\(--text-lg\)\s*;/);
    // Not the weaker / wrong alternatives, and no padding (so (e′) does not
    // collect it as a `.marlo-panel` padding rule), no media query.
    assert.doesNotMatch(subhead.body, /overflow-wrap:\s*break-word/);
    assert.doesNotMatch(subhead.body, /word-break/);
    assert.doesNotMatch(subhead.body, /\bpadding\s*:/);
    assert.equal(model.insideMedia(subhead.offset), false);
    // No copy of the rule inside any @media block either.
    for (const range of model.mediaRanges) {
      assert.doesNotMatch(range.body, /\.marlo-panel__subhead/);
    }

    // (5) It sits above the BOOK-FE-21 mobile block (which stays last).
    assert.ok(
      subhead.offset < model.mobileStart,
      `.marlo-panel__subhead at ${subhead.offset} must precede the mobile block at ${model.mobileStart}`,
    );
    // Immediately after the base .marlo-panel rule, per the work order.
    const panelRules = model.rules.filter(
      (rule) => rule.selector === '.marlo-panel' && /\bpadding\s*:/.test(rule.body),
    );
    assert.equal(panelRules.length, 1, 'exactly one base .marlo-panel rule');
    const panel = panelRules[0];
    assert.ok(panel.offset < subhead.offset);
    assert.equal(
      model.rules.some((rule) => rule.offset > panel.offset && rule.offset < subhead.offset),
      false,
      '.marlo-panel__subhead directly follows the base .marlo-panel rule',
    );

    // (6) The base .marlo-panel rule declares min-width: 0 and still padding
    // (so (e′) keeps collecting it); width / max-width stay.
    assert.match(panel.body, /min-width:\s*0\s*;/);
    assert.match(panel.body, /\bpadding\s*:/);
    assert.match(panel.body, /\bwidth:\s*100%\s*;/);
    assert.match(panel.body, /max-width:\s*1040px\s*;/);

    // (7) No importance flag, no ellipsis, no clipping on the panel or page.
    assert.equal(css.includes('!' + 'important'), false);
    assert.equal(css.includes('text-overflow'), false);
    const pageRules = model.rules.filter((rule) => rule.selector === '.marlo-page');
    assert.ok(pageRules.length >= 1);
    for (const rule of [panel, subhead, ...pageRules]) {
      assert.doesNotMatch(rule.body, /overflow(-x)?\s*:\s*(hidden|clip)/, rule.selector);
    }
    for (const range of model.mediaRanges) {
      for (const inner of range.body.matchAll(/([^{}]+?)\{([^{}]*)\}/g)) {
        const selector = inner[1].trim();
        if (selector === '.marlo-panel' || selector === '.marlo-page') {
          assert.doesNotMatch(inner[2], /overflow(-x)?\s*:\s*(hidden|clip)/, selector);
        }
      }
    }

    // (8) The (e′) cascade-order invariants still hold on the same text: every
    // non-media hero-font-size / panel-padding / page-padding rule precedes
    // the mobile block, and the block's selectors are bare single classes.
    const collected = model.rules.filter(
      (rule) =>
        (rule.selector.includes('.marlo-display--hero') && /\bfont-size\s*:/.test(rule.body)) ||
        (rule.selector.includes('.marlo-panel') && /\bpadding\s*:/.test(rule.body)) ||
        (rule.selector.includes('.marlo-page') && /\bpadding\s*:/.test(rule.body)),
    );
    assert.ok(collected.length >= 3);
    assert.equal(collected.some((rule) => rule.selector === '.marlo-panel__subhead'), false);
    for (const rule of collected) {
      assert.ok(rule.offset < model.mobileStart, `${rule.selector} at ${rule.offset}`);
    }
    for (const inner of model.mobile.body.matchAll(/([^{}]+?)\{([^{}]*)\}/g)) {
      const selector = inner[1].trim();
      assert.ok(selector.startsWith('.marlo-') && !/[\s>+~,\[:]/.test(selector), selector);
    }
    // The mobile block is the last rule-set in the file.
    assert.equal(model.blanked.slice(model.mobile.end).trim(), '');

    // Source: the page uses the class and no inline font size.
    const source = readFileSync(path.join(ROOT, 'app/(public)/b/[token]/page.tsx'), 'utf8');
    assert.match(source, /marlo-panel__subhead/);
    assert.doesNotMatch(source, /fontSize/);
    assert.doesNotMatch(source, /<p style=/);
  });
});
