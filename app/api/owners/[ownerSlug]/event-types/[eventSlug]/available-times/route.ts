import { availableTimes } from '@/lib/booking/service';
import { ensureOwnerFixtures } from '@/lib/booking/fixtures';
import { errorResponse, windowFrom } from '@/lib/api/route-helpers';

// C2 — owner-scoped availability. 404 `owner_not_found` / `event_type_not_found`;
// in pg/live mode a resolved `group`/`collective` kind is 501 after the
// read-only catalog read and before any lock, store write, or Google call (C6.9).

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { params: Promise<{ ownerSlug: string; eventSlug: string }> },
) {
  const { ownerSlug, eventSlug } = await context.params;
  const url = new URL(request.url);
  const window = windowFrom(url);
  if (window === null) {
    return Response.json(
      { error: 'timeMin and timeMax are required' },
      { status: 400 },
    );
  }

  await ensureOwnerFixtures(ownerSlug);

  try {
    const { times } = await availableTimes({ ownerSlug, eventSlug, window });
    return Response.json({ times });
  } catch (error) {
    const mapped = errorResponse(error);
    if (mapped !== null) {
      return mapped;
    }
    throw error;
  }
}
