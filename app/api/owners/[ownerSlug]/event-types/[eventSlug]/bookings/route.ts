import { createBookingEntry } from '@/lib/booking/service';
import { fixtureCreateResponse } from '@/lib/booking/fixture-create';
import { ensureOwnerFixtures } from '@/lib/booking/fixtures';
import {
  errorResponse,
  idempotencyKeyOf,
  originOf,
  readJsonBody,
} from '@/lib/api/route-helpers';

// C2 — the owner-scoped create. Body unchanged (`{ start, invitee, notes? }`);
// the `Idempotency-Key` header is **required** (C9) and is checked *after* the
// read-only catalog resolution and *after* the C6.9 kind gate (REV15-03), which
// is why a resolved `group`/`collective` kind is never answered 400.

export const dynamic = 'force-dynamic';

type Body = {
  start?: unknown;
  invitee?: { name?: unknown; email?: unknown };
  notes?: unknown;
};

export async function POST(
  request: Request,
  context: { params: Promise<{ ownerSlug: string; eventSlug: string }> },
) {
  const { ownerSlug, eventSlug } = await context.params;
  const body = await readJsonBody<Body>(request);
  if (body === null) {
    return Response.json({ error: 'invalid json body' }, { status: 400 });
  }

  const start = typeof body.start === 'string' ? body.start : '';
  const name = typeof body.invitee?.name === 'string' ? body.invitee.name : '';
  const email = typeof body.invitee?.email === 'string' ? body.invitee.email : '';
  if (!start || !name || !email) {
    return Response.json(
      { error: 'start and invitee name/email are required' },
      { status: 400 },
    );
  }

  try {
    // Inside the boundary: seeding resolves the runtime, and in pg mode that is
    // where a missing driver or an unreachable database surfaces (REV-07).
    await ensureOwnerFixtures(ownerSlug);
    const result = await createBookingEntry(
      {
        ownerSlug,
        eventSlug,
        start,
        invitee: { name, email },
        notes: typeof body.notes === 'string' ? body.notes : null,
        idempotencyKey: idempotencyKeyOf(request),
        origin: originOf(request),
      },
      // C6.9 — a memory-mode `group`/`collective` keeps its existing fixture
      // path, reached before the key check ever runs (REV15-03).
      (eventType) =>
        fixtureCreateResponse({ eventType, start, invitee: { name, email } }),
    );
    if (result.kind === 'fixture') {
      return result.response;
    }
    // 201 whenever the booking row is committed — an email failure never turns
    // a committed booking into a 4xx/5xx (AC-10).
    return Response.json(result.outcome.envelope, { status: 201 });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}
