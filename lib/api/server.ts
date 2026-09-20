import { getBooking } from '../booking/booking';
import { mapBooking } from './client';
import type { PublicBooking } from './types';

// Server-side helper for the confirmation shell: reads the existing in-memory
// booking row directly (no HTTP round trip from a Server Component to itself).
// Returns null when the row is missing (e.g. another serverless isolate); the
// page still renders the branded shell for that token.
export function getBookingByToken(token: string): PublicBooking | null {
  const trimmed = token.trim();
  if (!trimmed) {
    return null;
  }
  return mapBooking(getBooking(trimmed));
}
