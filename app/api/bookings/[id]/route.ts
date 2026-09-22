import { getBooking } from '@/lib/booking/booking';
import { readBooking } from '@/lib/booking/service';
import { authorizedScope, resolveBookingId } from '@/lib/api/booking-routes';
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

  if (resolved.kind === 'durable') {
    try {
      const scope = await authorizedScope(request, resolved.row);
      return Response.json(await readBooking(scope), { status: 200 });
    } catch (error) {
      const mapped = errorResponse(error);
      if (mapped !== null) {
        return mapped;
      }
      throw error;
    }
  }

  const legacy = getBooking(id);
  if (!legacy) {
    return Response.json({ error: 'booking not found' }, { status: 404 });
  }
  return Response.json({ booking: legacy });
}
