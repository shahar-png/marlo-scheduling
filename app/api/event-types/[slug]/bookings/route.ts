import {
  DEMO_OWNER_ID,
  ownersOfSlug,
  resolveEventType,
} from '@/lib/availability/event-type';
import {
  bookAvailableSlot,
  BookingConflictError,
  BookingNotFoundError,
  BookingValidationError,
} from '@/lib/booking/booking';
import {
  getBookingCalendarProvider,
  setBookingCalendarProvider,
} from '@/lib/booking/calendar-runtime';
import { getHostCalendarConnection } from '@/lib/calendar/connection';
import { DEMO_EVENT_SLUG, ensureDemoFixtures } from '@/lib/demo/seed';

export { setBookingCalendarProvider };

// C2 — the legacy create. Kept for fixtures/tests and not linked from any page.
// `slug` resolves **only** within the `demo` owner; a slug owned by someone else
// is 404 `owner_required`.
//
// The C6.9 kinds (`group`, `collective`) keep their existing memory-mode fixture
// path here with no key, no fingerprint, and no C9 record — the exemption that
// keeps `tests/group-route.test.ts` and `tests/collective-route.test.ts` passing
// byte-for-byte unmodified (REV15-03).

type BookingBody = {
  start?: unknown;
  invitee?: {
    name?: unknown;
    email?: unknown;
  };
};

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> },
) {
  const { slug } = await context.params;

  let body: BookingBody;
  try {
    body = (await request.json()) as BookingBody;
  } catch {
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

  const eventType = resolveEventType(DEMO_OWNER_ID, slug);
  if (!eventType) {
    const owners = ownersOfSlug(slug);
    if (owners.length > 0 && !owners.includes(DEMO_OWNER_ID)) {
      return Response.json({ error: 'owner_required' }, { status: 404 });
    }
    return Response.json({ error: 'event type not found' }, { status: 404 });
  }

  const connection = getHostCalendarConnection(eventType.hostId);
  const calendarId = connection?.destinationCalendarId ?? 'primary';

  try {
    const booking = await bookAvailableSlot({
      eventType,
      start,
      invitee: { name, email },
      provider: getBookingCalendarProvider(),
      calendarId,
    });
    return Response.json({ booking }, { status: 201 });
  } catch (error) {
    if (error instanceof BookingValidationError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof BookingNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof BookingConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}
