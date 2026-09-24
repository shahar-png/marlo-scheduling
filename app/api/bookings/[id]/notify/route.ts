import { notifyBooking } from '@/lib/booking/service';
import { authorizedScope, durableRowOf, resolveBookingId } from '@/lib/api/booking-routes';
import { errorResponse, originOf, readJsonBody } from '@/lib/api/route-helpers';

// C2 / C5 — `POST /api/bookings/{id}/notify`, token-authenticated. Two request
// forms: `{ action, expectedRevision }` (revision-specific) and `{}` (explicit
// retry-latest). The route runs the three ordered phases of C5 — N-1 lifecycle
// recovery, N-2 repair/reap, N-3 the notification claim — so a claim is never a
// recovery and an unfinished create gets N-1's answer, not a refusal (REV15-01).

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const body = (await readJsonBody<Record<string, unknown>>(request)) ?? {};

  const resolved = await resolveBookingId(id);
  try {
    const scope = await authorizedScope(request, durableRowOf(resolved));
    const outcome = await notifyBooking(scope, body, originOf(request));
    return Response.json(
      {
        ...outcome.envelope,
        ...(outcome.retried === null ? {} : { retried: outcome.retried }),
      },
      { status: 200 },
    );
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}
