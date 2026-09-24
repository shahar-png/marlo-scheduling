// AC-1 / AC-2 (P1) — owner-scoped identity end to end, and AC-22 / C10 — the
// one-off link entry point refused on the live path.
//
// P1 is a locked product decision: the booking page is `/{ownerSlug}/{eventSlug}`
// and every host-facing string is *that* host's. The test two owners share an
// event slug on purpose, because a global slug registry would silently serve
// one owner's page under the other's URL.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { createBooking, resolveScope } from '../lib/booking/service';
import { LifecycleError } from '../lib/booking/errors';
import { ONE_ON_ONE, createEventType, resolveEventType } from '../lib/availability/event-type';
import {
  eventTypeIdFor,
  ownerIdForSlug,
  scheduleIdFor,
  isValidSlug,
  normalizeSlug,
} from '../lib/owners';
import { DEMO, MONDAY_0900, isoAt, withHarness } from './support/harness';

const ORIGIN = 'https://marlo.test';
const INVITEE = { name: 'Ada Lovelace', email: 'ada@example.com' };

async function expectError(fn: () => Promise<unknown>): Promise<LifecycleError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof LifecycleError, `expected LifecycleError, got ${String(error)}`);
    return error;
  }
  throw new Error('expected the call to reject');
}

describe('AC-1 — two owners may both offer intro-30 (P1)', () => {
  it('resolves each to its own owner, host, calendar, and first name', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({
        slug: 'ada',
        firstName: 'Ada',
        email: 'ada@owners.test',
        calendarId: 'ada-primary',
      });
      await harness.seedOwner({
        slug: 'bob',
        firstName: 'Bob',
        email: 'bob@owners.test',
        calendarId: 'bob-primary',
      });

      const adaScope = await resolveScope('ada', 'intro-30');
      const bobScope = await resolveScope('bob', 'intro-30');

      assert.notEqual(adaScope.eventType.id, bobScope.eventType.id);
      assert.equal(adaScope.meta.hostFirstName, 'Ada');
      assert.equal(bobScope.meta.hostFirstName, 'Bob');
      assert.equal(adaScope.owner.calendarId, 'ada-primary');
      assert.equal(bobScope.owner.calendarId, 'bob-primary');

      // Book both: each event lands on its own owner's calendar and each
      // confirmation reaches that owner, not the other.
      const adaBooking = await createBooking({
        ownerSlug: 'ada',
        eventSlug: 'intro-30',
        start: MONDAY_0900,
        invitee: INVITEE,
        notes: null,
        idempotencyKey: crypto.randomUUID(),
        origin: ORIGIN,
      });
      const bobBooking = await createBooking({
        ownerSlug: 'bob',
        eventSlug: 'intro-30',
        start: MONDAY_0900,
        invitee: INVITEE,
        notes: null,
        idempotencyKey: crypto.randomUUID(),
        origin: ORIGIN,
      });

      assert.equal(adaBooking.envelope.booking.ownerSlug, 'ada');
      assert.equal(adaBooking.envelope.booking.hostFirstName, 'Ada');
      assert.equal(bobBooking.envelope.booking.ownerSlug, 'bob');
      assert.equal(bobBooking.envelope.booking.hostFirstName, 'Bob');

      const calendars = harness.calendar.calls
        .filter((call) => call.kind === 'insert')
        .map((call) => call.calendarId)
        .sort();
      assert.deepEqual(calendars, ['ada-primary', 'bob-primary']);

      const ownerRecipients = harness.sender.sent
        .filter((entry) => entry.recipient === 'owner')
        .map((entry) => entry.to)
        .sort();
      assert.deepEqual(ownerRecipients, ['ada@owners.test', 'bob@owners.test']);

      // The same wall-clock slot for two DIFFERENT hosts is not a conflict.
      assert.equal(adaBooking.envelope.booking.status, 'confirmed');
      assert.equal(bobBooking.envelope.booking.status, 'confirmed');
    });
  });

  it('scopes event-type uniqueness to the owner, not globally', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: 'ada' });
      await harness.seedOwner({ slug: 'bob' });

      assert.notEqual(
        resolveEventType(ownerIdForSlug('ada'), 'intro-30')?.id,
        resolveEventType(ownerIdForSlug('bob'), 'intro-30')?.id,
      );

      // A duplicate slug under the SAME owner is refused.
      assert.throws(() =>
        createEventType({
          id: 'evt_dup',
          ownerId: ownerIdForSlug('ada'),
          hostId: ownerIdForSlug('ada'),
          slug: 'intro-30',
          name: 'Duplicate',
          durationMinutes: 30,
          availabilityScheduleId: scheduleIdFor('ada', 'default'),
          kind: ONE_ON_ONE,
        }),
      );
    });
  });

  it('derives stable ids, so a fresh isolate resolves a persisted booking', async () => {
    assert.equal(ownerIdForSlug('ada'), 'own_ada');
    assert.equal(eventTypeIdFor('ada', 'intro-30'), 'evt_ada__intro-30');
    assert.equal(scheduleIdFor('ada', 'default'), 'sch_ada__default');

    await withHarness('pg', async (harness) => {
      const seeded = await harness.seedOwner({ slug: DEMO.ownerSlug });
      const created = await createBooking({
        ownerSlug: DEMO.ownerSlug,
        eventSlug: DEMO.eventSlug,
        start: MONDAY_0900,
        invitee: INVITEE,
        notes: null,
        idempotencyKey: crypto.randomUUID(),
        origin: ORIGIN,
      });
      assert.equal(created.row.eventTypeId, seeded.eventTypeId);

      // A new module instance over the same durable state resolves the row's
      // event type and serves it — the point of the deterministic C1 ids.
      const fresh = harness.freshIsolate();
      const row = await fresh.store.getById(created.row.id);
      assert.ok(row !== null);
      assert.equal(row.eventTypeId, seeded.eventTypeId);

      const byToken = await fresh.store.getByToken(created.envelope.booking.token);
      assert.equal(byToken?.id, created.row.id);

      // And the booking's occupancy is visible to the fresh instance.
      const overlapping = await expectError(() =>
        createBooking({
          ownerSlug: DEMO.ownerSlug,
          eventSlug: DEMO.eventSlug,
          start: isoAt(15),
          invitee: INVITEE,
          notes: null,
          idempotencyKey: crypto.randomUUID(),
          origin: ORIGIN,
        }),
      );
      assert.equal(overlapping.code, 'slot_unavailable');
    });
  });

  it('404s an unknown owner and an unknown event under a known owner', async () => {
    await withHarness('memory', async (harness) => {
      await harness.seedOwner({ slug: 'ada' });

      const unknownOwner = await expectError(() => resolveScope('nobody', 'intro-30'));
      assert.equal(unknownOwner.code, 'owner_not_found');

      const unknownEvent = await expectError(() => resolveScope('ada', 'no-such-event'));
      assert.equal(unknownEvent.code, 'event_type_not_found');
    });
  });

  it('validates and lower-cases slugs', () => {
    // The AC-2 pattern is `^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`: 64 is the
    // longest accepted slug, 65 the shortest rejected one.
    for (const slug of ['a', 'intro-30', 'a-b-c', 'x'.repeat(64)]) {
      assert.equal(isValidSlug(slug), true, slug);
    }
    for (const slug of ['', '-lead', 'trail-', 'UPPER', 'a..b', '../etc', 'x'.repeat(65)]) {
      assert.equal(isValidSlug(slug), false, JSON.stringify(slug));
    }
    assert.equal(normalizeSlug('  Intro-30 '), 'intro-30');
  });

  it('no host-facing copy hard-codes a first name', () => {
    // AC-1's grep half: host chrome must come from `owner.firstName`.
    for (const file of ['lib/email/templates.ts', 'app/(public)/b/[token]/page.tsx']) {
      const source = readFileSync(path.join(process.cwd(), file), 'utf8');
      assert.equal(
        /\bShahar\b/.test(source),
        false,
        `${file} must not hard-code a host first name`,
      );
    }
  });
});

describe('AC-22 / C10 — one-off links are fixture-only', () => {
  it('pg mode refuses both link routes before any side effect', async () => {
    await withHarness('pg', async (harness) => {
      await harness.seedOwner({ slug: DEMO.ownerSlug });
      harness.db().clearLog();

      const { GET } = await import('../app/api/links/[token]/available-times/route');
      const { POST } = await import('../app/api/links/[token]/bookings/route');

      const params = { params: Promise.resolve({ token: 'lnk_1' }) };
      const read = await GET(new Request('http://localhost/api/links/lnk_1/available-times'), params);
      assert.equal(read.status, 501);
      assert.deepEqual(await read.json(), { error: 'links_not_supported' });

      const write = await POST(
        new Request('http://localhost/api/links/lnk_1/bookings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ start: MONDAY_0900, invitee: INVITEE }),
        }),
        params,
      );
      assert.equal(write.status, 501);
      assert.deepEqual(await write.json(), { error: 'links_not_supported' });

      // The refusal is the FIRST statement: no store query, no calendar, no mail.
      assert.deepEqual(harness.db().sqlLog(), []);
      assert.deepEqual(harness.calendar.calls, []);
      assert.deepEqual(harness.sender.sent, []);
    });
  });
});
