import { readBooking } from '@/lib/booking/service';
import { authorizedScope, durableRowOf, resolveBookingId } from '@/lib/api/booking-routes';
import { errorResponse } from '@/lib/api/route-helpers';

// C2 / C11 — `GET /api/bookings/{id}`, token-authenticated with
// `Authorization: Bearer {token}`. `{id}` is the booking id, never the token;
// the id alone grants nothing. This is also one of the designated observing
// calls for the C6.3a reap.
//
// A legacy in-memory fixture row (retained `/api/event-types/*` and
// `/api/links/*` paths, outside the C6 contract) is still served by its
// existing read.

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const resolved = await resolveBookingId(id);

  // Only an existing fixture row takes the legacy read; an id that resolves to
  // nothing is authenticated exactly like a durable one, so the response can
  // never reveal whether the booking exists (C11 — REV-08).
  if (resolved.kind === 'legacy') {
    return Response.json({ booking: resolved.booking });
  }

  try {
    const scope = await authorizedScope(request, durableRowOf(resolved));
    return Response.json(await readBooking(scope), { status: 200 });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}
