// AC-19 (client half) — the unresolved-submission record, reload recovery, and
// the terminal / non-terminal rule that decides when a key may be discarded.
//
// The rule is the whole point: clearing the record on a response that does NOT
// prove the key unusable is exactly how a guest ends up with two bookings
// (REV8-01), and retaining it on one that does is how they get stuck.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BookingFormStore,
  type BookingFormDeps,
} from '../app/(public)/[slug]/[event]/booking-form-store';
import {
  isReplayable,
  isTerminalForKey,
  readRecord,
  submissionStorageKey,
  type RecordStorage,
} from '../app/(public)/[slug]/[event]/submission-record';
import {
  SESSION_FULL,
  SLOT_UNAVAILABLE,
  UNKNOWN_ERROR,
  type CreateBookingInput,
  type CreateBookingResult,
  type PublicBooking,
} from '../lib/api/types';

const OWNER = 'ada';
const EVENT = 'intro-30';
const START = '2026-09-21T09:00:00.000Z';

function memoryStorage(seed: Record<string, string> = {}): RecordStorage & {
  entries(): Record<string, string>;
} {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    entries: () => Object.fromEntries(map),
  };
}

function booking(token: string): PublicBooking {
  return {
    id: `bk_${token}`,
    token,
    start: START,
    end: '2026-09-21T09:30:00.000Z',
    status: 'confirmed',
    eventTypeId: 'evt',
    invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
  };
}

type Harness = {
  store: BookingFormStore;
  storage: ReturnType<typeof memoryStorage>;
  navigations: string[];
  creates: CreateBookingInput[];
  recoveries: CreateBookingInput[];
  slotLoads: number;
  order: string[];
  logs: Array<{ code: string; fields: Record<string, unknown> }>;
  /** Every wait the single automatic replay asked for, in milliseconds. */
  waits: number[];
};

function harness(options: {
  storage?: ReturnType<typeof memoryStorage>;
  create?: (input: CreateBookingInput) => Promise<CreateBookingResult>;
  recover?: (input: CreateBookingInput) => Promise<CreateBookingResult>;
  keys?: string[];
} = {}): Harness {
  const storage = options.storage ?? memoryStorage();
  const navigations: string[] = [];
  const creates: CreateBookingInput[] = [];
  const recoveries: CreateBookingInput[] = [];
  const order: string[] = [];
  const logs: Array<{ code: string; fields: Record<string, unknown> }> = [];
  const waits: number[] = [];
  const keys = [...(options.keys ?? ['key-1', 'key-2', 'key-3'])];
  let slotLoads = 0;

  const deps: BookingFormDeps = {
    slug: EVENT,
    ownerSlug: OWNER,
    durationMinutes: 30,
    timeZone: 'UTC',
    storage,
    newKey: () => keys.shift() ?? 'key-exhausted',
    log: (code, fields) => logs.push({ code, fields }),
    api: {
      async getSlots() {
        order.push('getSlots');
        slotLoads += 1;
        return { times: [{ start: START }] };
      },
      async createBooking(input) {
        order.push('createBooking');
        creates.push(input);
        return (
          options.create?.(input) ?? Promise.resolve({ ok: true, booking: booking('tok-1') })
        );
      },
    },
    ...(options.recover === undefined
      ? {}
      : {
          recover: async (input) => {
            order.push('recoverBooking');
            recoveries.push(input);
            return options.recover!(input);
          },
        }),
    navigate: (href) => navigations.push(href),
    now: () => new Date('2026-09-21T08:00:00.000Z'),
    schedule: { setInterval: () => 0, clearInterval: () => {} },
    // C9's single automatic replay waits the server's own window; the test
    // drives that wait rather than sleeping through it.
    waitFor: async (ms) => {
      waits.push(ms);
    },
  };

  const store = new BookingFormStore(deps);
  return {
    store,
    storage,
    navigations,
    creates,
    recoveries,
    order,
    logs,
    waits,
    get slotLoads() {
      return slotLoads;
    },
  } as Harness;
}

async function fillAndSubmit(h: Harness): Promise<void> {
  h.store.selectSlot(START);
  h.store.setName('Ada Lovelace');
  h.store.setEmail('ada@example.com');
  await h.store.submit();
}

describe('AC-19 — terminal vs non-terminal is the whole contract (C9)', () => {
  it('classifies exactly the responses that prove the key unusable', () => {
    // Terminal: a row cannot exist, and none can be inserted later.
    assert.equal(isTerminalForKey(201, null), true);
    assert.equal(isTerminalForKey(400, 'idempotency_key_required'), true);
    assert.equal(isTerminalForKey(409, 'slot_unavailable'), true);
    assert.equal(isTerminalForKey(409, 'session_full'), true);
    assert.equal(isTerminalForKey(422, 'idempotency_key_reused'), true);

    // Non-terminal: the original create may still be alive.
    assert.equal(isTerminalForKey(409, 'operation_in_progress'), false);
    assert.equal(isTerminalForKey(409, 'operation_superseded'), false);
    assert.equal(isTerminalForKey(503, 'booking_outcome_unknown'), false);
    assert.equal(isTerminalForKey(500, 'booking_failed'), false);
    assert.equal(isTerminalForKey(501, 'group_not_supported'), false);

    assert.equal(isReplayable(409, 'operation_in_progress'), true);
    assert.equal(isReplayable(503, 'booking_outcome_unknown'), true);
    assert.equal(isReplayable(500, null), true);
    assert.equal(isReplayable(409, 'slot_unavailable'), false);
  });
});

describe('AC-19 — the record is written before the request', () => {
  it('persists { key, payload } and sends the key with the request', async () => {
    const h = harness();
    await fillAndSubmit(h);

    assert.equal(h.creates.length, 1);
    assert.equal(h.creates[0].idempotencyKey, 'key-1');
    assert.equal(h.creates[0].ownerSlug, OWNER);
    // Cleared on the 201.
    assert.equal(readRecord(h.storage, OWNER, EVENT), null);
    assert.deepEqual(h.navigations, ['/b/tok-1']);
  });

  it('retains the record on a network error and replays the STORED payload', async () => {
    const h = harness({
      create: async () => {
        throw new Error('ECONNRESET');
      },
    });
    await fillAndSubmit(h);

    const record = readRecord(h.storage, OWNER, EVENT);
    assert.ok(record !== null, 'the record survives a lost response');
    assert.equal(record.key, 'key-1');
    assert.equal(record.payload.start, START);
    assert.equal(record.payload.invitee.email, 'ada@example.com');
  });

  it('clears the record on a terminal 409 and keeps it on a non-terminal one', async () => {
    const terminal = harness({
      create: async () => ({ ok: false, code: SLOT_UNAVAILABLE }),
    });
    await fillAndSubmit(terminal);
    assert.equal(
      readRecord(terminal.storage, OWNER, EVENT),
      null,
      'a fenced rejection is safe to clear',
    );

    const nonTerminal = harness({
      create: async () => ({
        ok: false,
        code: UNKNOWN_ERROR,
        status: 409,
        error: 'operation_in_progress',
      }),
    });
    await fillAndSubmit(nonTerminal);
    const record = readRecord(nonTerminal.storage, OWNER, EVENT);
    assert.ok(record !== null, 'the original create may still be alive');
    assert.equal(record.key, 'key-1');
  });

  it('replays a non-terminal operation_in_progress once, automatically, after the server’s window', async () => {
    // C9 / AC-19(f′): the original create is provably still running and the
    // server named a wait, so the client honours it and replays the SAME key
    // and payload once before asking the guest to do anything.
    const outcomes: CreateBookingResult[] = [
      { ok: false, code: UNKNOWN_ERROR, status: 409, error: 'operation_in_progress', retryAfterSeconds: 3 },
      { ok: true, booking: booking('tok-replayed') },
    ];
    const h = harness({ create: async () => outcomes.shift() ?? outcomes[0] });

    await fillAndSubmit(h);

    assert.deepEqual(h.waits, [3000], 'waits exactly the window the server named');
    assert.equal(h.creates.length, 2, 'exactly one automatic replay');
    assert.equal(h.creates[0].idempotencyKey, 'key-1');
    assert.equal(h.creates[1].idempotencyKey, 'key-1', 'the same key, never a second one');
    assert.deepEqual(h.navigations, ['/b/tok-replayed']);
    assert.equal(readRecord(h.storage, OWNER, EVENT), null, 'a 201 resolves the record');
  });

  it('stalls after the automatic replay is also refused, then Try again restores it', async () => {
    const h = harness({
      create: async () => ({
        ok: false,
        code: UNKNOWN_ERROR,
        status: 409,
        error: 'operation_in_progress',
        retryAfterSeconds: 2,
      }),
    });

    await fillAndSubmit(h);

    assert.deepEqual(h.waits, [2000]);
    assert.equal(h.creates.length, 2, 'one submission plus one automatic replay');
    assert.equal(h.store.getState().recovery, 'stalled');
    assert.ok(readRecord(h.storage, OWNER, EVENT) !== null, 'the key is retained');

    // **Try again** re-sends the same request and restores the one automatic
    // replay, exactly as C12's `stalled` → Try again does for the token page.
    await h.store.retryRecovery();
    assert.equal(h.creates.length, 4);
    assert.deepEqual(h.waits, [2000, 2000]);
    assert.equal(h.store.getState().recovery, 'stalled');
  });

  it('keeps the record on 501 group/collective, where no key was consumed', async () => {
    for (const error of ['group_not_supported', 'collective_not_supported']) {
      const h = harness({
        create: async () => ({ ok: false, code: UNKNOWN_ERROR, status: 501, error }),
      });
      await fillAndSubmit(h);
      assert.ok(readRecord(h.storage, OWNER, EVENT) !== null, error);
    }
  });

  it('clears the record on a terminal 422', async () => {
    const h = harness({
      create: async () => ({
        ok: false,
        code: UNKNOWN_ERROR,
        status: 422,
        error: 'idempotency_key_reused',
      }),
    });
    await fillAndSubmit(h);
    assert.equal(readRecord(h.storage, OWNER, EVENT), null);
  });

  it('clears on a terminal session_full too', async () => {
    const h = harness({ create: async () => ({ ok: false, code: SESSION_FULL }) });
    await fillAndSubmit(h);
    assert.equal(readRecord(h.storage, OWNER, EVENT), null);
  });
});

describe('AC-19(h) — reload recovery runs BEFORE availability loads (REV3-06)', () => {
  const seeded = () =>
    memoryStorage({
      [submissionStorageKey(OWNER, EVENT)]: JSON.stringify({
        key: 'key-lost',
        payload: {
          ownerSlug: OWNER,
          eventSlug: EVENT,
          start: START,
          invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
        },
        startedAt: '2026-09-21T07:59:00.000Z',
      }),
    });

  it('replays the stored record first and navigates to the ORIGINAL booking', async () => {
    const h = harness({
      storage: seeded(),
      recover: async () => ({ ok: true, booking: booking('tok-original') }),
    });

    assert.equal(h.store.getState().recovery, 'recovering', 'the form is hidden');
    await h.store.start();

    // The call-order assertion is the point: a picker must never be shown
    // before the outstanding submission is resolved.
    assert.equal(h.order[0], 'recoverBooking');
    assert.equal(h.recoveries[0].idempotencyKey, 'key-lost');
    assert.deepEqual(h.navigations, ['/b/tok-original']);
    assert.equal(readRecord(h.storage, OWNER, EVENT), null);
    assert.equal(h.order.includes('getSlots'), false, 'availability was never loaded');
  });

  it('recovers an elapsed slot, which a NEW submission would refuse', async () => {
    // The stored start is in the past relative to the store's clock… and the
    // replay must still finish the booking (the gates are for new submissions).
    const storage = memoryStorage({
      [submissionStorageKey(OWNER, EVENT)]: JSON.stringify({
        key: 'key-elapsed',
        payload: {
          ownerSlug: OWNER,
          eventSlug: EVENT,
          start: '2026-09-21T07:00:00.000Z',
          invitee: { name: 'Ada Lovelace', email: 'ada@example.com' },
        },
        startedAt: '2026-09-21T06:59:00.000Z',
      }),
    });
    const h = harness({
      storage,
      recover: async () => ({ ok: true, booking: booking('tok-elapsed') }),
    });

    await h.store.start();
    assert.deepEqual(h.navigations, ['/b/tok-elapsed']);
  });

  it('stalls on a 503 and offers Try again / Start over', async () => {
    let attempts = 0;
    const h = harness({
      storage: seeded(),
      recover: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, code: UNKNOWN_ERROR, status: 503, error: 'booking_outcome_unknown' }
          : { ok: true, booking: booking('tok-second') };
      },
    });

    await h.store.start();
    assert.equal(h.store.getState().recovery, 'stalled');
    assert.ok(readRecord(h.storage, OWNER, EVENT) !== null, 'the record is retained');
    assert.equal(h.order.includes('getSlots'), false);

    // Try again re-sends the same key and payload.
    await h.store.retryRecovery();
    assert.equal(h.recoveries[1].idempotencyKey, 'key-lost');
    assert.deepEqual(h.navigations, ['/b/tok-second']);
  });

  it('Start over discards the record explicitly, and only then loads availability', async () => {
    const h = harness({
      storage: seeded(),
      recover: async () => ({
        ok: false,
        code: UNKNOWN_ERROR,
        status: 503,
        error: 'booking_outcome_unknown',
      }),
    });

    await h.store.start();
    assert.equal(h.store.getState().recovery, 'stalled');

    await h.store.discardRecovery();
    assert.equal(readRecord(h.storage, OWNER, EVENT), null);
    assert.equal(h.store.getState().recovery, 'idle');
    assert.ok(h.order.includes('getSlots'), 'availability loads once the record is resolved');
    assert.deepEqual(
      h.logs.map((entry) => entry.code),
      ['submission_discarded'],
    );
  });

  it('a terminal 4xx on replay shows one notice and returns to the normal flow', async () => {
    const h = harness({
      storage: seeded(),
      recover: async () => ({ ok: false, code: SLOT_UNAVAILABLE }),
    });

    await h.store.start();
    assert.equal(readRecord(h.storage, OWNER, EVENT), null);
    assert.equal(h.store.getState().recovery, 'idle');
    assert.equal(h.store.getState().recoveryNotice, true);
    assert.ok(h.order.includes('getSlots'));
    assert.deepEqual(h.navigations, []);
  });

  it('with no record it loads availability directly', async () => {
    const h = harness();
    assert.equal(h.store.getState().recovery, 'idle');
    await h.store.start();
    assert.equal(h.order[0], 'getSlots');
  });
});

describe('AC-19(j) — a late response for a superseded key is dropped (REV8-01)', () => {
  it('ignores a response whose key is no longer the unresolved record', async () => {
    const storage = memoryStorage();
    const gate: { release: (result: CreateBookingResult) => void } = {
      release: () => {},
    };
    const h = harness({
      storage,
      create: () =>
        new Promise<CreateBookingResult>((resolve) => {
          gate.release = resolve;
        }),
    });

    const inFlight = fillAndSubmit(h);
    await Promise.resolve();
    assert.equal(readRecord(storage, OWNER, EVENT)?.key, 'key-1');

    // The guest gives up on this attempt: the record is discarded.
    await h.store.discardRecovery();
    assert.equal(readRecord(storage, OWNER, EVENT), null);

    // The original request finally answers — for a key the client no longer owns.
    gate.release({ ok: true, booking: booking('tok-late') });
    await inFlight;

    assert.deepEqual(h.navigations, [], 'a dropped response never navigates');
    assert.equal(readRecord(storage, OWNER, EVENT), null, 'and never revives a record');
    assert.deepEqual(
      h.logs.filter((entry) => entry.code === 'stale_response_ignored').length,
      1,
    );
  });
});

describe('AC-19 — the store is unchanged when no storage is injected', () => {
  it('books without a key, a record, or recovery (the retained fixture surface)', async () => {
    const navigations: string[] = [];
    const creates: CreateBookingInput[] = [];
    const store = new BookingFormStore({
      slug: EVENT,
      durationMinutes: 30,
      timeZone: 'UTC',
      api: {
        async getSlots() {
          return { times: [{ start: START }] };
        },
        async createBooking(input) {
          creates.push(input);
          return { ok: true, booking: booking('tok-legacy') };
        },
      },
      navigate: (href) => navigations.push(href),
      now: () => new Date('2026-09-21T08:00:00.000Z'),
      schedule: { setInterval: () => 0, clearInterval: () => {} },
    });

    store.selectSlot(START);
    store.setName('Ada Lovelace');
    store.setEmail('ada@example.com');
    await store.submit();

    assert.equal(creates[0].idempotencyKey, undefined);
    assert.equal(store.unresolved(), null);
    assert.deepEqual(navigations, ['/b/tok-legacy']);
  });
});
