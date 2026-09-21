import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BookingForm } from '../app/(public)/[slug]/[event]/BookingForm';
import {
  createBookingFormStore,
  isValidEmail,
  type BookingFormStore,
  type Scheduler,
} from '../app/(public)/[slug]/[event]/booking-form-store';
import { MARK_PATH, WORDMARK_PATH } from '../app/components/Logo';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { createApiClient } from '../lib/api/client';
import { createHandlerTransport } from '../lib/api/handler-transport';
import type { ApiRequest, Transport } from '../lib/api/transport';
import type {
  BookingApi,
  CreateBookingInput,
  CreateBookingResult,
  GetSlotsInput,
  Slot,
} from '../lib/api/types';
import { createEventType, resetEventTypes } from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { listConfirmedBookingsForHost, resetBookings } from '../lib/booking/booking';
import { resetCalendarConnections } from '../lib/calendar/connection';
import { createFixtureCalendarProvider } from '../lib/calendar/google-freebusy';
import type { GoogleFreeBusyFixture } from '../lib/calendar/google-freebusy';
import { t } from '../lib/copy';

const ROOT = process.cwd();
const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, 'tests/fixtures/google-freebusy.json'), 'utf8'),
) as GoogleFreeBusyFixture;

const T_0959 = '2026-09-20T09:59:00.000Z';
const T_1000 = '2026-09-20T10:00:00.000Z';
const T_1001 = '2026-09-20T10:01:00.000Z';
const T_1030 = '2026-09-20T10:30:00.000Z';

// react-dom/server escapes `'` as &#x27; in text nodes.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

const SLOT_TAKEN = t('details.errors.slotTaken');
const SESSION_FULL_COPY = 'That session just filled up';
const EMAIL_COPY = escapeHtml(t('details.errors.email'));
const SUBMIT_LABEL = t('details.submit');

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type HarnessOptions = {
  now: string;
  // Every render passes an explicit zone — never the machine's (BOOK-FE-09).
  timeZone?: string;
  slots?: Slot[] | (() => Slot[]);
  getSlots?: (input: GetSlotsInput) => Promise<{ times: Slot[] }>;
  createBooking?: (input: CreateBookingInput) => Promise<CreateBookingResult>;
  slug?: string;
  // Route the `slots` stub through the real lib/api adapter (over a recording
  // transport) so the outgoing backend query (clamped / widened) is visible
  // in `backendCalls` while `getSlotsCalls` still records the form's request.
  viaAdapter?: boolean;
};

function harness(options: HarnessOptions) {
  const clock = { value: new Date(options.now) };
  const now = () => clock.value;
  const timeZone = options.timeZone ?? 'UTC';
  const getSlotsCalls: GetSlotsInput[] = [];
  const backendCalls: ApiRequest[] = [];
  const createCalls: CreateBookingInput[] = [];
  const navigations: string[] = [];
  let tickFn: (() => void) | null = null;
  let cleared = 0;

  const stubSlots = () =>
    typeof options.slots === 'function' ? options.slots() : options.slots ?? [];
  const recordingTransport: Transport = async (request) => {
    backendCalls.push(request);
    return {
      status: 200,
      body: { times: stubSlots().map((slot) => (slot.spotsRemaining === undefined ? slot.start : { start: slot.start, spots_remaining: slot.spotsRemaining })) },
    };
  };
  const adapter = createApiClient({ transport: recordingTransport, now });

  const api: BookingApi = {
    async getSlots(input) {
      getSlotsCalls.push(input);
      if (options.getSlots) {
        return options.getSlots(input);
      }
      if (options.viaAdapter) {
        return adapter.getSlots(input);
      }
      return { times: stubSlots() };
    },
    async createBooking(input) {
      createCalls.push(input);
      if (options.createBooking) {
        return options.createBooking(input);
      }
      return { ok: true, booking: { token: 'tok-1', start: input.start, end: '', status: 'confirmed', eventTypeId: 'et-1', invitee: input.invitee } };
    },
  };
  const schedule: Scheduler = {
    setInterval: (callback) => {
      tickFn = callback;
      return 'interval-1';
    },
    clearInterval: () => {
      cleared += 1;
    },
  };
  const slug = options.slug ?? 'intro-30';
  const store = createBookingFormStore({
    slug,
    durationMinutes: 30,
    timeZone,
    api,
    navigate: (href) => {
      navigations.push(href);
    },
    now,
    schedule,
  });

  function render(activeStore: BookingFormStore = store): string {
    return renderToStaticMarkup(
      <BookingForm
        slug={slug}
        hostSlug="demo"
        eventMeta={{ name: 'Intro call', durationMinutes: 30, kind: 'one_on_one' }}
        hostMeta={{ firstName: 'Marlo' }}
        timeZone={timeZone}
        api={api}
        navigate={(href) => navigations.push(href)}
        now={now}
        schedule={schedule}
        store={activeStore}
      />,
    );
  }

  return {
    api,
    store,
    render,
    getSlotsCalls,
    backendCalls,
    createCalls,
    navigations,
    advance: (iso: string) => {
      clock.value = new Date(iso);
    },
    fireTick: () => {
      assert.ok(tickFn, 'expiry timer not started');
      tickFn!();
    },
    clearedCount: () => cleared,
  };
}

function fillDetails(store: BookingFormStore, start: string) {
  assert.equal(store.selectSlot(start), true);
  store.setName('Ada Lovelace');
  store.setEmail('ada@example.com');
}

function submitEvent() {
  let prevented = 0;
  return {
    event: { preventDefault: () => { prevented += 1; } },
    prevented: () => prevented,
  };
}

function offers(html: string, start: string): boolean {
  return html.includes(`data-slot="${start}"`);
}

function submitDisabled(html: string): boolean {
  const match = /<button[^>]*data-submit="true"[^>]*>/.exec(html);
  return match !== null && /\bdisabled=""/.test(match[0]) && /aria-disabled="true"/.test(match[0]);
}

function seedIntro30(weekday = 0) {
  const schedule = createAvailabilitySchedule({
    hostId: 'host-1',
    timezone: 'UTC',
    windows: [{ weekday, start: '09:00', end: '20:00' }],
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

describe('AC-4 real form interaction (BookingForm rendered directly, in-memory api)', () => {
  it('renders branded chrome and copy keys with slots offered', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    const html = h.render();
    assert.match(html, /data-logo="wordmark"/);
    assert.match(html, /data-logo="mark"/);
    assert.match(html, /marlo-page/);
    assert.match(html, /marlo-card/);
    assert.ok(html.includes(t('booking.headline', { hostFirstName: 'Marlo' })));
    assert.ok(html.includes(t('booking.timesShownIn', { timezoneLabel: 'UTC' })));
    assert.ok(html.includes(t('brand.poweredBy')));
    assert.ok(html.includes(t('booking.duration', { minutes: 30 })));
    assert.ok(offers(html, T_1000));
    assert.ok(offers(html, T_1030));
    assert.equal(html.includes(SUBMIT_LABEL), false);
    assert.equal(h.getSlotsCalls.length, 1);
    assert.deepEqual(
      [h.getSlotsCalls[0].timeMin, h.getSlotsCalls[0].timeMax],
      ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    );
    // BOOK-FE-12: the form passes the duration and the logical window only.
    assert.equal(h.getSlotsCalls[0].durationMinutes, 30);
    // Day controls carry the month (BOOK-FE-09).
    assert.match(html, /Sun, Sep 20/);
    assert.match(html, /September 2026/);
  });

  it('BOOK-FE-15 (iii): BookingForm renders the canonical host chrome it is given — it never sees the URL segment', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }] });
    await h.store.load();
    const html = h.render();
    assert.ok(html.includes(t('booking.headline', { hostFirstName: 'Marlo' })));
    assert.match(html, /data-booking-page="demo"/);
    assert.equal(html.includes('Alice'), false);
    const form = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/BookingForm.tsx'),
      'utf8',
    );
    // The form's only name source is hostMeta.firstName (a prop from the
    // Server page's canonical HostMeta); no prop carries the URL `[slug]`.
    assert.match(form, /hostMeta\.firstName/);
    assert.doesNotMatch(form, /toUpperCase\(/);
    assert.doesNotMatch(form, /hostFirstNameForSlug/);
  });

  it('(a)(b) select → name/email → submit sends { start, invitee } and navigates to /b/{token}', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    fillDetails(h.store, T_1000);
    const step2 = h.render();
    assert.ok(step2.includes(SUBMIT_LABEL));
    assert.ok(step2.includes(t('details.headline')));
    assert.equal(submitDisabled(step2), false);

    const { event, prevented } = submitEvent();
    await h.store.submit(event);

    assert.equal(prevented(), 1);
    assert.equal(h.createCalls.length, 1);
    assert.deepEqual(h.createCalls[0], {
      slug: 'intro-30',
      start: T_1000,
      invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
      now: h.createCalls[0].now,
    });
    assert.deepEqual(h.navigations, ['/b/tok-1']);
    // Guard stays set after success: control renders disabled until unmount.
    assert.ok(submitDisabled(h.render()));
  });

  describe('through the existing booking service (adapter over the route handlers)', () => {
    beforeEach(() => {
      resetAvailabilitySchedules();
      resetEventTypes();
      resetBookings();
      resetCalendarConnections();
      setBookingCalendarProvider(null);
    });

    it('creates one booking row on the existing service and navigates to /b/{id}', async () => {
      seedIntro30();
      setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
      const real = createApiClient({ transport: createHandlerTransport() });
      const h = harness({
        now: '2026-09-20T08:00:00.000Z',
        getSlots: (input) => real.getSlots(input),
        createBooking: (input) => real.createBooking(input),
      });
      await h.store.load();
      assert.ok(offers(h.render(), '2026-09-20T09:00:00.000Z'));
      fillDetails(h.store, '2026-09-20T09:00:00.000Z');
      await h.store.submit();

      const rows = listConfirmedBookingsForHost('host-1');
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].invitee, { name: 'Ada Lovelace', email: 'ada@example.com' });
      assert.deepEqual(h.navigations, [`/b/${rows[0].id}`]);
    });
  });

  it('(c) 409 slot_unavailable: slotTaken copy, getSlots re-invoked, selection cleared, no navigation', async () => {
    const h = harness({
      now: T_0959,
      slots: [{ start: T_1000 }, { start: T_1030 }],
      createBooking: async () => ({ ok: false, code: 'slot_unavailable' }),
    });
    await h.store.load();
    fillDetails(h.store, T_1000);
    await h.store.submit();

    const html = h.render();
    assert.ok(html.includes(SLOT_TAKEN));
    assert.equal(html.includes(SESSION_FULL_COPY), false);
    assert.equal(h.getSlotsCalls.length, 2);
    assert.equal(h.store.getState().selectedStart, null);
    assert.equal(html.includes(SUBMIT_LABEL), false);
    assert.ok(offers(html, T_1030));
    assert.deepEqual(h.navigations, []);
    assert.equal(h.store.isPending(), false);
  });

  it("(c′) BOOK-FE-07 409 session_full: sessionFull copy (not slotTaken), same recovery, no navigation", async () => {
    const h = harness({
      now: T_0959,
      slots: [{ start: T_1000, spotsRemaining: 1 }, { start: T_1030, spotsRemaining: 4 }],
      createBooking: async () => ({ ok: false, code: 'session_full' }),
    });
    await h.store.load();
    assert.ok(h.render().includes(t('booking.spotsLeft', { count: 4 })));
    fillDetails(h.store, T_1000);
    await h.store.submit();

    const html = h.render();
    assert.ok(html.includes(SESSION_FULL_COPY));
    assert.equal(html.includes(SLOT_TAKEN), false);
    assert.equal(h.getSlotsCalls.length, 2);
    assert.deepEqual(
      [h.getSlotsCalls[1].timeMin, h.getSlotsCalls[1].timeMax],
      ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    );
    assert.equal(h.store.getState().selectedStart, null);
    assert.deepEqual(h.navigations, []);
    assert.equal(h.createCalls.length, 1);
  });

  it('(d) BOOK-FE-04: the Server page passes only serializable props', () => {
    const page = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/page.tsx'),
      'utf8',
    );
    assert.doesNotMatch(page, /getSlots/);
    assert.doesNotMatch(page, /createBooking/);
    assert.doesNotMatch(page, /useRouter/);
    assert.doesNotMatch(page, /\bapi=/);
    assert.doesNotMatch(page, /\bnavigate=/);
    assert.doesNotMatch(page, /\bnow=/);
    // BOOK-FE-09: the server does not know the zone, so it picks no month.
    assert.doesNotMatch(page, /\btimeZone=/);
    assert.doesNotMatch(page, /\binitialMonth=/);
    assert.doesNotMatch(page, /monthOf/);
    assert.doesNotMatch(page, /resolvedOptions/);
    assert.doesNotMatch(page, /lib\/api\/client/);
    assert.doesNotMatch(page, /^'use client'/m);
    assert.match(page, /<BookingClient/);
    // BOOK-FE-15/19: no name from URL text; every path through the constructor.
    assert.doesNotMatch(page, /hostFirstNameForSlug/);
    assert.doesNotMatch(page, /toUpperCase\(/);
    assert.match(page, /import \{ publicBookingPath \} from '@\/lib\/api\/public-path'/);
    assert.doesNotMatch(page, /`\/\$\{/);

    const client = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/BookingClient.tsx'),
      'utf8',
    );
    assert.match(client, /^'use client';/m);
    assert.match(client, /useRouter/);
    assert.match(client, /api=\{api\}/);
    assert.match(client, /navigate=\{navigate\}/);
    assert.match(client, /now=\{now\}/);
    assert.match(client, /timeZone=\{timeZone\}/);
    assert.match(client, /resolvedOptions\(\)/);

    // The form and the store never reach for the machine zone; it is injected.
    const form = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/BookingForm.tsx'),
      'utf8',
    );
    assert.match(form, /^'use client';/m);
    assert.doesNotMatch(form, /resolvedOptions/);
    const storeSource = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/booking-form-store.ts'),
      'utf8',
    );
    assert.doesNotMatch(storeSource, /resolvedOptions/);
    assert.doesNotMatch(storeSource, /Date\.now\(/);
    const monthSource = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/month.ts'),
      'utf8',
    );
    assert.doesNotMatch(monthSource, /resolvedOptions/);
    assert.doesNotMatch(monthSource, /date-fns/);
  });

  it('shows details.errors.required when submitting without name/email and releases the guard', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }] });
    await h.store.load();
    h.store.selectSlot(T_1000);
    await h.store.submit();
    assert.equal(h.createCalls.length, 0);
    assert.ok(h.render().includes(t('details.errors.required')));
    assert.equal(h.store.isPending(), false);
  });
});

describe('BOOK-FE-08 in-flight submit guard (deferred response)', () => {
  it('(i) double submit while in flight → one createBooking, one navigation, disabled control, guard held', async () => {
    const gate = deferred<CreateBookingResult>();
    const h = harness({
      now: T_0959,
      slots: [{ start: T_1000 }, { start: T_1030 }],
      createBooking: () => gate.promise,
    });
    await h.store.load();
    fillDetails(h.store, T_1000);

    const first = h.store.submit();
    const second = h.store.submit(); // synchronous re-entry
    await Promise.resolve();
    const third = h.store.submit(); // after a microtask tick, still before resolution

    assert.equal(h.createCalls.length, 1);
    assert.equal(h.store.isPending(), true);
    const pendingHtml = h.render();
    assert.ok(pendingHtml.includes(SUBMIT_LABEL));
    assert.ok(submitDisabled(pendingHtml));
    assert.match(pendingHtml, /data-pending="true"/);
    assert.equal(pendingHtml.includes(SLOT_TAKEN), false);

    gate.resolve({
      ok: true,
      booking: { token: 'tok-9', start: T_1000, end: '', status: 'confirmed', eventTypeId: 'et-1', invitee: { name: 'Ada Lovelace', email: 'ada@example.com' } },
    });
    await Promise.all([first, second, third]);

    assert.deepEqual(h.navigations, ['/b/tok-9']);
    assert.equal(h.createCalls.length, 1);

    // After the 201 and navigate: still a no-op.
    await h.store.submit();
    assert.equal(h.createCalls.length, 1);
    assert.equal(h.navigations.length, 1);
    assert.equal(h.store.isPending(), true);
    assert.ok(submitDisabled(h.render()));
  });

  describe('against the existing group booking service (capacity 2)', () => {
    beforeEach(() => {
      resetAvailabilitySchedules();
      resetEventTypes();
      resetBookings();
      resetCalendarConnections();
      setBookingCalendarProvider(null);
    });

    it('holds one seat for the invitee, not two', async () => {
      const schedule = createAvailabilitySchedule({
        hostId: 'host-1',
        timezone: 'UTC',
        windows: [{ weekday: 0, start: '09:00', end: '20:00' }],
      });
      createEventType({
        hostId: 'host-1',
        slug: 'workshop',
        name: 'Workshop',
        durationMinutes: 30,
        availabilityScheduleId: schedule.id,
        kind: 'group',
        maxInvitees: 2,
      });
      const provider = createFixtureCalendarProvider(FIXTURE);
      setBookingCalendarProvider(provider);
      const real = createApiClient({ transport: createHandlerTransport() });
      const gate = deferred<void>();
      const h = harness({
        now: '2026-09-20T08:00:00.000Z',
        slug: 'workshop',
        getSlots: (input) => real.getSlots(input),
        createBooking: (input) => gate.promise.then(() => real.createBooking(input)),
      });
      await h.store.load();
      fillDetails(h.store, '2026-09-20T09:00:00.000Z');

      const first = h.store.submit();
      const second = h.store.submit();
      await Promise.resolve();
      const third = h.store.submit();
      assert.equal(h.createCalls.length, 1);

      gate.resolve();
      await Promise.all([first, second, third]);

      const rows = listConfirmedBookingsForHost('host-1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].invitee.email, 'ada@example.com');
      assert.equal(provider.createdEvents.length, 1);
      assert.deepEqual(h.navigations, [`/b/${rows[0].id}`]);
    });
  });

  it('(ii) deferred 409 slot_unavailable releases the guard: re-select + submit calls createBooking again', async () => {
    let gate = deferred<CreateBookingResult>();
    const h = harness({
      now: T_0959,
      slots: [{ start: T_1000 }, { start: T_1030 }],
      createBooking: () => gate.promise,
    });
    await h.store.load();
    fillDetails(h.store, T_1000);

    const first = h.store.submit();
    const second = h.store.submit();
    assert.equal(h.createCalls.length, 1);
    assert.ok(submitDisabled(h.render()));

    gate.resolve({ ok: false, code: 'slot_unavailable' });
    await Promise.all([first, second]);

    const html = h.render();
    assert.ok(html.includes(SLOT_TAKEN));
    assert.equal(h.store.getState().selectedStart, null);
    assert.equal(h.getSlotsCalls.length, 2);
    assert.equal(h.store.isPending(), false);
    assert.deepEqual(h.navigations, []);

    gate = deferred<CreateBookingResult>();
    fillDetails(h.store, T_1030);
    const again = h.store.submit();
    assert.equal(h.createCalls.length, 2);
    assert.equal(h.createCalls[1].start, T_1030);
    gate.resolve({
      ok: true,
      booking: { token: 'tok-2', start: T_1030, end: '', status: 'confirmed', eventTypeId: 'et-1', invitee: { name: 'Ada Lovelace', email: 'ada@example.com' } },
    });
    await again;
    assert.deepEqual(h.navigations, ['/b/tok-2']);
  });
});

describe('AC-7 past-slot cutoff in the UI (fixed clock)', () => {
  it('(b) slot selected before now, now advanced past it → recheck fails, slotTaken, refreshed, cleared, no createBooking', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    fillDetails(h.store, T_1000);
    h.advance(T_1001);
    await h.store.submit();

    assert.equal(h.createCalls.length, 0);
    const html = h.render();
    assert.ok(html.includes(SLOT_TAKEN));
    assert.equal(h.getSlotsCalls.length, 2);
    assert.equal(h.store.getState().selectedStart, null);
    assert.equal(offers(html, T_1000), false);
    assert.ok(offers(html, T_1030));
    assert.deepEqual(h.navigations, []);
    assert.equal(h.store.isPending(), false);
  });

  it('(e) month boundary: selection in M, now into M+1 → recovery queries the M+1 window and renders empty', async () => {
    const LAST_DAY = '2026-09-30T10:00:00.000Z';
    let phase = 0;
    const h = harness({
      now: '2026-09-30T09:00:00.000Z',
      slots: () => (phase === 0 ? [{ start: LAST_DAY }] : []),
    });
    await h.store.load();
    fillDetails(h.store, LAST_DAY);
    phase = 1;
    h.advance('2026-10-01T09:00:00.000Z');
    await h.store.submit();

    assert.equal(h.createCalls.length, 0);
    assert.equal(h.getSlotsCalls.length, 2);
    assert.deepEqual(
      [h.getSlotsCalls[1].timeMin, h.getSlotsCalls[1].timeMax],
      ['2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
    );
    assert.equal(h.store.getState().month, '2026-10');
    const html = h.render();
    assert.ok(html.includes(SLOT_TAKEN));
    assert.ok(html.includes(t('booking.emptyMonth')));
    assert.match(html, /data-month="2026-10"/);
    assert.equal(h.store.getState().selectedStart, null);
    assert.deepEqual(h.navigations, []);
  });

  it('session_full recovery runs the same routine and stays on the displayed month while it is live', async () => {
    const LAST_DAY = '2026-09-30T10:00:00.000Z';
    const h = harness({
      now: '2026-09-30T09:00:00.000Z',
      slots: [{ start: LAST_DAY, spotsRemaining: 1 }],
      createBooking: async () => ({ ok: false, code: 'session_full' }),
    });
    await h.store.load();
    fillDetails(h.store, LAST_DAY);
    h.advance('2026-09-30T09:30:00.000Z');
    await h.store.submit();
    assert.equal(h.createCalls.length, 1);
    assert.ok(h.render().includes(SESSION_FULL_COPY));
    assert.equal(h.getSlotsCalls.length, 2);
    assert.equal(h.getSlotsCalls[1].timeMin, '2026-09-01T00:00:00.000Z');
    assert.equal(h.store.getState().month, '2026-09');
    assert.equal(h.store.getState().selectedStart, null);
  });

  it('recovery after the month has fully elapsed renders empty availability, never throws', async () => {
    // Displayed month September; now already in October when the 409 arrives.
    const h = harness({
      now: '2026-09-30T23:00:00.000Z',
      slots: [{ start: '2026-09-30T23:30:00.000Z' }],
      createBooking: async () => ({ ok: false, code: 'slot_unavailable' }),
    });
    await h.store.load();
    fillDetails(h.store, '2026-09-30T23:30:00.000Z');
    h.advance('2026-10-01T00:00:00.000Z');
    await h.store.submit();
    assert.equal(h.createCalls.length, 0); // elapsed recheck wins
    assert.equal(h.store.getState().month, '2026-10');
    assert.equal(h.getSlotsCalls[1].timeMin, '2026-10-01T00:00:00.000Z');
    assert.ok(h.render().includes(SLOT_TAKEN));
  });
});

describe('BOOK-FE-06 slot expiry while the picker is open', () => {
  it('(i) tick after the clock advances drops 10:00 and keeps 10:30 (no selection made)', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    const stop = h.store.startExpiryTimer();
    assert.ok(offers(h.render(), T_1000));

    h.advance(T_1001);
    h.fireTick();
    const html = h.render();
    assert.equal(offers(html, T_1000), false);
    assert.ok(offers(html, T_1030));
    assert.equal(h.getSlotsCalls.length, 1);

    stop();
    assert.equal(h.clearedCount(), 1);
  });

  it('(i) the focus handler re-evaluates the clock the same way', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    h.advance(T_1001);
    h.store.handleFocus();
    const html = h.render();
    assert.equal(offers(html, T_1000), false);
    assert.ok(offers(html, T_1030));
  });

  it('(ii) selection-time guard: onSelectSlot for an elapsed start records nothing and drops it', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    h.advance(T_1001);
    // No tick fired yet: the 10:00 control may still be on screen.
    assert.equal(h.store.selectSlot(T_1000), false);
    assert.equal(h.store.getState().selectedStart, null);
    const html = h.render();
    assert.equal(offers(html, T_1000), false);
    assert.ok(offers(html, T_1030));
    assert.equal(html.includes(SUBMIT_LABEL), false);
  });

  it('(iii) late response: request at 09:59, clock at 10:01 when it resolves → only 10:30 rendered', async () => {
    const gate = deferred<{ times: Slot[] }>();
    const h = harness({ now: T_0959, getSlots: () => gate.promise });
    const loading = h.store.load();
    assert.ok(h.render().includes(t('booking.loadingSlots')));
    h.advance(T_1001);
    gate.resolve({ times: [{ start: T_1000 }, { start: T_1030 }] });
    await loading;
    const html = h.render();
    assert.equal(offers(html, T_1000), false);
    assert.ok(offers(html, T_1030));
  });

  it('(iv) a selected slot that expires is cleared by the tick before any submit', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    h.store.startExpiryTimer();
    assert.equal(h.store.selectSlot(T_1000), true);
    assert.ok(h.render().includes(SUBMIT_LABEL));
    h.advance(T_1001);
    h.fireTick();
    assert.equal(h.store.getState().selectedStart, null);
    const html = h.render();
    assert.equal(html.includes(SUBMIT_LABEL), false);
    assert.equal(offers(html, T_1000), false);
    assert.ok(offers(html, T_1030));
  });
});

describe('BOOK-FE-09 month = displayed time zone (fixed clock + explicit timeZone)', () => {
  function backendQuery(h: ReturnType<typeof harness>, index: number) {
    const url = new URL(h.backendCalls[index].path, 'http://localhost');
    return { timeMin: url.searchParams.get('timeMin'), timeMax: url.searchParams.get('timeMax') };
  }

  it('(i) Pacific/Kiritimati (+14): now = Sep 30 10:30Z is Oct 1 locally → October window, start grouped under Oct 1', async () => {
    const h = harness({
      now: '2026-09-30T10:30:00.000Z',
      timeZone: 'Pacific/Kiritimati',
      slots: [{ start: '2026-09-30T11:00:00.000Z' }],
      viaAdapter: true,
    });
    assert.equal(h.store.getState().month, '2026-10');
    await h.store.load();

    // The form sends the logical, tz-aware window (no + duration) …
    assert.equal(h.getSlotsCalls.length, 1);
    assert.deepEqual(
      [h.getSlotsCalls[0].timeMin, h.getSlotsCalls[0].timeMax],
      ['2026-09-30T10:00:00.000Z', '2026-10-31T10:00:00.000Z'],
    );
    assert.equal(h.getSlotsCalls[0].durationMinutes, 30);
    // … and the adapter clamps timeMin to now and widens the backend end bound.
    assert.deepEqual(backendQuery(h, 0), {
      timeMin: '2026-09-30T10:30:00.000Z',
      timeMax: '2026-10-31T10:30:00.000Z',
    });

    const html = h.render();
    assert.match(html, /October 2026/);
    assert.doesNotMatch(html, /September 2026/);
    assert.match(html, /data-month="2026-10"/);
    assert.match(html, /data-date="2026-10-01"/);
    assert.doesNotMatch(html, /data-date="2026-09-30"/);
    assert.match(html, /Thu, Oct 1/);
    assert.ok(offers(html, '2026-09-30T11:00:00.000Z'));
  });

  it('(ii) Pacific/Pago_Pago (−11): now = Oct 1 05:00Z is Sep 30 locally → September window; recovery advances to October', async () => {
    const START = '2026-10-01T08:00:00.000Z'; // Sep 30 21:00 local
    const h = harness({
      now: '2026-10-01T05:00:00.000Z',
      timeZone: 'Pacific/Pago_Pago',
      slots: [{ start: START }],
      viaAdapter: true,
    });
    assert.equal(h.store.getState().month, '2026-09');
    await h.store.load();

    assert.deepEqual(
      [h.getSlotsCalls[0].timeMin, h.getSlotsCalls[0].timeMax],
      ['2026-09-01T11:00:00.000Z', '2026-10-01T11:00:00.000Z'],
    );
    assert.deepEqual(backendQuery(h, 0), {
      timeMin: '2026-10-01T05:00:00.000Z',
      timeMax: '2026-10-01T11:30:00.000Z',
    });
    let html = h.render();
    assert.match(html, /September 2026/);
    assert.match(html, /data-date="2026-09-30"/);
    assert.match(html, /Wed, Sep 30/);
    assert.ok(offers(html, START));

    // Stale selection, then the clock crosses local month-end (Oct 1 01:00
    // local = 12:00Z): the elapsed recheck fails and recovery advances the
    // displayed month to October in the displayed zone.
    fillDetails(h.store, START);
    h.advance('2026-10-01T12:00:00.000Z');
    await h.store.submit();

    assert.equal(h.createCalls.length, 0);
    assert.equal(h.store.getState().month, '2026-10');
    assert.equal(h.getSlotsCalls.length, 2);
    assert.deepEqual(
      [h.getSlotsCalls[1].timeMin, h.getSlotsCalls[1].timeMax],
      ['2026-10-01T11:00:00.000Z', '2026-11-01T11:00:00.000Z'],
    );
    assert.equal(backendQuery(h, 1).timeMin, '2026-10-01T12:00:00.000Z');
    html = h.render();
    assert.ok(html.includes(SLOT_TAKEN));
    assert.match(html, /October 2026/);
    assert.equal(h.store.getState().selectedStart, null);
    assert.deepEqual(h.navigations, []);
  });

  it('(iii) out-of-month filter: a start whose Kiritimati date is outside the displayed month is not rendered', async () => {
    // Displayed October (Kiritimati). Raw stub bypasses the adapter so the
    // form's own guard is what drops the out-of-month start.
    const IN_MONTH = '2026-10-10T00:00:00.000Z'; // Oct 10 14:00 local
    const NEXT_MONTH = '2026-10-31T12:00:00.000Z'; // Nov 1 02:00 local
    const h = harness({
      now: '2026-09-30T10:30:00.000Z',
      timeZone: 'Pacific/Kiritimati',
      slots: [{ start: IN_MONTH }, { start: NEXT_MONTH }],
    });
    await h.store.load();
    const html = h.render();
    assert.match(html, /data-month="2026-10"/);
    assert.ok(offers(html, IN_MONTH));
    assert.equal(offers(html, NEXT_MONTH), false);
    assert.doesNotMatch(html, /data-date="2026-11-01"/);
    assert.equal(h.store.selectSlot(NEXT_MONTH), true); // future, but …
    assert.equal(h.render().includes(SUBMIT_LABEL), false); // … not offered, so no details step
  });

  it('(iii) … and a start that is still Sep 30 in Kiritimati is not listed under October', async () => {
    const SEP_30_LOCAL = '2026-09-30T09:00:00.000Z'; // Sep 30 23:00 local
    const h = harness({
      now: '2026-09-30T08:00:00.000Z', // Sep 30 22:00 local → displayed September
      timeZone: 'Pacific/Kiritimati',
      slots: [{ start: SEP_30_LOCAL }, { start: '2026-09-30T11:00:00.000Z' }],
    });
    assert.equal(h.store.getState().month, '2026-09');
    await h.store.load();
    let html = h.render();
    assert.ok(offers(html, SEP_30_LOCAL));
    assert.equal(offers(html, '2026-09-30T11:00:00.000Z'), false); // Oct 1 local
    await h.store.nextMonth();
    html = h.render();
    assert.match(html, /data-month="2026-10"/);
    assert.equal(offers(html, SEP_30_LOCAL), false);
    assert.ok(offers(html, '2026-09-30T11:00:00.000Z'));
  });

  it('(iv) timeZone: UTC reproduces the prior UTC month expectations', async () => {
    const h = harness({ now: T_0959, timeZone: 'UTC', slots: [{ start: T_1000 }] });
    assert.equal(h.store.getState().month, '2026-09');
    await h.store.load();
    assert.deepEqual(
      [h.getSlotsCalls[0].timeMin, h.getSlotsCalls[0].timeMax],
      ['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    );
    assert.match(h.render(), /September 2026/);
  });

  it('BOOK-FE-12 form side: Asia/Kathmandu September keeps the logical bound and renders 18:00Z under Sep 30', async () => {
    const LAST_START = '2026-09-30T18:00:00.000Z'; // Sep 30 23:45 local; ends past 18:15Z
    const h = harness({
      now: '2026-09-30T00:00:00.000Z',
      timeZone: 'Asia/Kathmandu',
      slots: [{ start: LAST_START }],
      viaAdapter: true,
    });
    assert.equal(h.store.getState().month, '2026-09');
    await h.store.load();
    assert.deepEqual(
      [h.getSlotsCalls[0].timeMin, h.getSlotsCalls[0].timeMax],
      ['2026-08-31T18:15:00.000Z', '2026-09-30T18:15:00.000Z'],
    );
    assert.equal(h.getSlotsCalls[0].durationMinutes, 30);
    const url = new URL(h.backendCalls[0].path, 'http://localhost');
    assert.equal(url.searchParams.get('timeMax'), '2026-09-30T18:45:00.000Z');
    const html = h.render();
    assert.match(html, /September 2026/);
    assert.match(html, /data-date="2026-09-30"/);
    assert.match(html, /Wed, Sep 30/);
    assert.ok(offers(html, LAST_START));
  });
});

describe('BOOK-FE-10/13 email syntax gate through the real submit handler', () => {
  const INVALID = [
    '@',
    'a@b',
    'a b@c.com',
    'a@.com',
    'a@b.',
    ' a@b .co',
    'a@ b.co',
    'a@b@c.co',
    'a@b..co',
    'a@.b.co',
    'a@b.co.',
  ];

  it('isValidEmail unit table', () => {
    for (const email of INVALID) {
      assert.equal(isValidEmail(email), false, `rejects ${JSON.stringify(email)}`);
    }
    assert.equal(isValidEmail('a@b.co'), true);
    assert.equal(isValidEmail('first.last+tag@sub.example.co.uk'), true);
    assert.equal(isValidEmail(' a@b.co '), true); // trimmed
  });

  it('each invalid email: details.errors.email, no createBooking, no getSlots, slot kept, latch released; then a corrected email books', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }, { start: T_1030 }] });
    await h.store.load();
    assert.equal(h.store.selectSlot(T_1000), true);
    h.store.setName('Ada Lovelace');

    for (const email of INVALID) {
      h.store.setEmail(email);
      await h.store.submit();

      assert.equal(h.createCalls.length, 0, `no createBooking for ${JSON.stringify(email)}`);
      assert.equal(h.getSlotsCalls.length, 1, `no getSlots refresh for ${JSON.stringify(email)}`);
      assert.deepEqual(h.navigations, []);
      const html = h.render();
      assert.ok(html.includes(EMAIL_COPY), `email copy for ${JSON.stringify(email)}`);
      assert.match(html, /data-error="email"/);
      assert.equal(html.includes(t('details.errors.required')), false);
      assert.equal(html.includes(SLOT_TAKEN), false);
      assert.equal(h.store.getState().selectedStart, T_1000);
      assert.equal(h.store.getState().month, '2026-09');
      assert.match(html, new RegExp(`data-selected-slot="${T_1000}"`));
      assert.ok(html.includes(SUBMIT_LABEL));
      assert.equal(submitDisabled(html), false);
      assert.equal(h.store.isPending(), false);
    }

    h.store.setEmail('a@b.co');
    await h.store.submit();
    assert.equal(h.createCalls.length, 1);
    assert.equal(h.createCalls[0].invitee.email, 'a@b.co');
    assert.equal(h.createCalls[0].start, T_1000);
    assert.deepEqual(h.navigations, ['/b/tok-1']);
  });

  it('the trimmed, validated email is what reaches the backend', async () => {
    const h = harness({ now: T_0959, slots: [{ start: T_1000 }] });
    await h.store.load();
    h.store.selectSlot(T_1000);
    h.store.setName('Ada');
    h.store.setEmail('  a@b.co  ');
    await h.store.submit();
    assert.equal(h.createCalls.length, 1);
    assert.equal(h.createCalls[0].invitee.email, 'a@b.co');
  });

  describe('against the existing booking service', () => {
    beforeEach(() => {
      resetAvailabilitySchedules();
      resetEventTypes();
      resetBookings();
      resetCalendarConnections();
      setBookingCalendarProvider(null);
    });

    it('no booking row after the invalid submits, one after the corrected one', async () => {
      seedIntro30();
      setBookingCalendarProvider(createFixtureCalendarProvider(FIXTURE));
      const real = createApiClient({ transport: createHandlerTransport() });
      const h = harness({
        now: '2026-09-20T08:00:00.000Z',
        getSlots: (input) => real.getSlots(input),
        createBooking: (input) => real.createBooking(input),
      });
      await h.store.load();
      h.store.selectSlot('2026-09-20T09:00:00.000Z');
      h.store.setName('Ada Lovelace');
      for (const email of ['@', 'a@b..co', 'a@b.co.']) {
        h.store.setEmail(email);
        await h.store.submit();
        assert.equal(listConfirmedBookingsForHost('host-1').length, 0);
        assert.equal(h.createCalls.length, 0);
      }
      h.store.setEmail('a@b.co');
      await h.store.submit();
      const rows = listConfirmedBookingsForHost('host-1');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].invitee.email, 'a@b.co');
      assert.deepEqual(h.navigations, [`/b/${rows[0].id}`]);
    });
  });
});

describe('AC-2 brand assets are copied from handoff/', () => {
  it('copy/en.json and app/tokens/marlo.css are byte-equal to their handoff sources', () => {
    assert.equal(
      readFileSync(path.join(ROOT, 'copy/en.json'), 'utf8'),
      readFileSync(path.join(ROOT, 'handoff/copy/en.json'), 'utf8'),
    );
    assert.equal(
      readFileSync(path.join(ROOT, 'app/tokens/marlo.css'), 'utf8'),
      readFileSync(path.join(ROOT, 'handoff/tokens/marlo.css'), 'utf8'),
    );
  });

  it('Logo path data equals handoff/assets/logo/*.svg', () => {
    const pathOf = (file: string) => {
      const svg = readFileSync(path.join(ROOT, 'handoff/assets/logo', file), 'utf8');
      const match = / d="([^"]+)"/.exec(svg);
      assert.ok(match, `${file} has a path`);
      return match[1];
    };
    assert.equal(MARK_PATH, pathOf('marlo-mark.svg'));
    assert.equal(WORDMARK_PATH, pathOf('marlo-wordmark.svg'));
    const logoSource = readFileSync(path.join(ROOT, 'app/components/Logo.tsx'), 'utf8');
    assert.match(logoSource, /currentColor/);
    assert.match(logoSource, /var\(--logo\)/);
  });

  it('layout imports the tokens and the Google Fonts pairing', () => {
    const layout = readFileSync(path.join(ROOT, 'app/layout.tsx'), 'utf8');
    assert.match(layout, /tokens\/marlo\.css/);
    assert.match(layout, /Outfit/);
    assert.match(layout, /Manrope/);
    assert.match(layout, /display=swap/);
  });
});
