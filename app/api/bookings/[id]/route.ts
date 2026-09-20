import { getBooking } from '@/lib/booking/booking';

// Thin public read adapter for the confirmation page (`/b/{token}`, token =
// booking id). Create/reschedule/cancel semantics are untouched.
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const booking = getBooking(id);
  if (!booking) {
    return Response.json({ error: 'booking not found' }, { status: 404 });
  }
  return Response.json({ booking });
}
