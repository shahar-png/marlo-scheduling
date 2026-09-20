import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { BookingForm } from '../app/(public)/[slug]/[event]/BookingForm';
import {
  createBookingFormStore,
  type BookingFormStore,
  type Scheduler,
} from '../app/(public)/[slug]/[event]/booking-form-store';
import { MARK_PATH, WORDMARK_PATH } from '../app/components/Logo';
import { setBookingCalendarProvider } from '../app/api/event-types/[slug]/bookings/route';
import { createApiClient } from '../lib/api/client';
import { createHandlerTransport } from '../lib/api/handler-transport';
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

const SLOT_TAKEN = t('details.errors.slotTaken');
const SESSION_FULL_COPY = 'That session just filled up';
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
  month?: string;
  slots?: Slot[] | (() => Slot[]);
  getSlots?: (input: GetSlotsInput) => Promise<{ times: Slot[] }>;
  createBooking?: (input: CreateBookingInput) => Promise<CreateBookingResult>;
  slug?: string;
};

function harness(options: HarnessOptions) {
  const clock = { value: new Date(options.now) };
  const now = () => clock.value;
  const getSlotsCalls: GetSlotsInput[] = [];
  const createCalls: CreateBookingInput[] = [];
  const navigations: string[] = [];
  let tickFn: (() => void) | null = null;
  let cleared = 0;

  const api: BookingApi = {
    async getSlots(input) {
      getSlotsCalls.push(input);
      if (options.getSlots) {
        return options.getSlots(input);
      }
      const slots =
        typeof options.slots === 'function' ? options.slots() : options.slots ?? [];
      return { times: slots };
    },
    async createBooking(input) {
      createCalls.push(input);
      if (options.createBooking) {
        return options.createBooking(input);
      }
      return { ok: true, booking: { token: 'tok-1', start: input.start, end: '', status: 'confirmed', invitee: input.invitee } };
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
    initialMonth: options.month ?? '2026-09',
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
        initialMonth={options.month ?? '2026-09'}
        timeZone="UTC"
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
    assert.doesNotMatch(page, /lib\/api\/client/);
    assert.doesNotMatch(page, /^'use client'/m);
    assert.match(page, /<BookingClient/);

    const client = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/BookingClient.tsx'),
      'utf8',
    );
    assert.match(client, /^'use client';/m);
    assert.match(client, /useRouter/);
    assert.match(client, /api=\{api\}/);
    assert.match(client, /navigate=\{navigate\}/);
    assert.match(client, /now=\{now\}/);

    const form = readFileSync(
      path.join(ROOT, 'app/(public)/[slug]/[event]/BookingForm.tsx'),
      'utf8',
    );
    assert.match(form, /^'use client';/m);
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
      booking: { token: 'tok-9', start: T_1000, end: '', status: 'confirmed', invitee: { name: 'Ada Lovelace', email: 'ada@example.com' } },
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
      booking: { token: 'tok-2', start: T_1030, end: '', status: 'confirmed', invitee: { name: 'Ada Lovelace', email: 'ada@example.com' } },
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
