import { bookingAvailability } from '@/lib/booking/service';
import { authorizedScope, durableRowOf, resolveBookingId } from '@/lib/api/booking-routes';
import { errorResponse, windowFrom } from '@/lib/api/route-helpers';

// C2 / C12 — the reschedule picker's source. Same occupancy computation as the
// owner-scoped availability route **minus this booking's own occupancy** (own
// interval, own reservation, own managed event), with candidates generated at
// the 15-minute reschedule increment, so an overlapping move is actually
// offered (REV3-08).

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const window = windowFrom(new URL(request.url));
  if (window === null) {
    return Response.json(
      { error: 'timeMin and timeMax are required' },
      { status: 400 },
    );
  }

  const resolved = await resolveBookingId(id);
  try {
    const scope = await authorizedScope(request, durableRowOf(resolved));
    return Response.json({ times: await bookingAvailability(scope, window) });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}
