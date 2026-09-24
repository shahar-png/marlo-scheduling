import {
  DEMO_OWNER_ID,
  ownersOfSlug,
  resolveEventType,
} from '@/lib/availability/event-type';
import { assertLiveKind, isFixtureOnlyKind } from '@/lib/catalog';
import { setBookingCalendarProvider } from '@/lib/booking/calendar-runtime';
import { fixtureCreateResponse } from '@/lib/booking/fixture-create';
import { ensureOwnerFixtures } from '@/lib/booking/fixtures';
import { createBooking } from '@/lib/booking/service';
import { DEMO_EVENT_SLUG, ensureDemoFixtures } from '@/lib/demo/seed';
import { resolveEnv } from '@/lib/env';
import {
  errorResponse,
  idempotencyKeyOf,
  originOf,
  readJsonBody,
} from '@/lib/api/route-helpers';
import { DEMO_OWNER_SLUG } from '@/lib/owners-materialize';

export { setBookingCalendarProvider };

// C2 — the legacy create. Kept for fixtures/tests and not linked from any page.
// `slug` resolves **only** within the `demo` owner; a slug owned by someone else
// is 404 `owner_required`.
//
// The order is the same one every create entry point uses (REV15-03):
//
//   1. read-only catalog resolution;
//   2. the C6.9 kind gate — 501 in pg/live mode, before any side effect;
//   3. the C2/C9 `Idempotency-Key` check, which a resolved `group`/`collective`
//      kind therefore never reaches;
//   4. the lifecycle.
//
// A `one_on_one` create runs the **shared demo-scoped lifecycle** — the same
// host lock, reservation-aware occupancy, two-phase create, and id/token model
// as the owner-scoped route — so it can neither double-book against a durable
// row nor mint a row that is readable without its bearer token. Only `group`
// and `collective` keep their existing memory-mode fixture path, with no key,
// no fingerprint, and no C9 record (C6.9).

export const dynamic = 'force-dynamic';

type BookingBody = {
  start?: unknown;
  invitee?: {
    name?: unknown;
    email?: unknown;
  };
  notes?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;

  const body = await readJsonBody<BookingBody>(request);
  if (body === null) {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }

  const start = typeof body.start === 'string' ? body.start : '';
  const name = typeof body.invitee?.name === 'string' ? body.invitee.name : '';
  const email =
    typeof body.invitee?.email === 'string' ? body.invitee.email : '';

  if (!start || !name || !email) {
    return Response.json(
      { error: 'start and invitee name/email are required' },
      { status: 400 },
    );
  }

  // Demo seed (no-op when the slug already exists; other slugs untouched).
  if (slug === DEMO_EVENT_SLUG) {
    ensureDemoFixtures();
  }

  // (1) Read-only catalog resolution, within the demo owner only.
  const eventType = resolveEventType(DEMO_OWNER_ID, slug);
  if (!eventType) {
    const owners = ownersOfSlug(slug);
    if (owners.length > 0 && !owners.includes(DEMO_OWNER_ID)) {
      return Response.json({ error: 'owner_required' }, { status: 404 });
    }
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }

  // (2) The C6.9 kind gate, before any lock, write, calendar call, or email.
  try {
    assertLiveKind(eventType.kind, resolveEnv().store === 'pg');
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }

  // (3)/(4) A fixture kind keeps its existing path — the exemption that keeps
  // `tests/group-route.test.ts` and `tests/collective-route.test.ts` passing
  // byte-for-byte unmodified (REV15-03). Everything else is a real booking.
  if (isFixtureOnlyKind(eventType.kind)) {
    return fixtureCreateResponse({
      eventType,
      start,
      invitee: { name, email },
    });
  }

  try {
    // Inside the boundary: seeding resolves the runtime, and in pg mode that is
    // where a missing driver or an unreachable database surfaces (REV-07).
    await ensureOwnerFixtures(DEMO_OWNER_SLUG);
    const outcome = await createBooking({
      ownerSlug: DEMO_OWNER_SLUG,
      eventSlug: slug,
      start,
      invitee: { name, email },
      notes: typeof body.notes === 'string' ? body.notes : null,
      idempotencyKey: idempotencyKeyOf(request),
      origin: originOf(request),
    });
    return Response.json(outcome.envelope, { status: 201 });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}

