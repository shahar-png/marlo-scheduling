// Identifier construction for the durable booking row (C11) and for Google
// event ids (C6.2).
//
// C11: `id` and `token` are two different things. The id is the API path
// segment and grants nothing; the token is the `/b/{token}` capability and the
// bearer credential. `id <> token` is both a schema CHECK and a store
// invariant.

import { randomBytes, timingSafeEqual } from 'node:crypto';
export { newCalendarEventId, isValidCalendarEventId } from '../google/calendar';

export function newBookingId(): string {
  return `bk_${crypto.randomUUID()}`;
}

/** 32 random bytes, base64url — 43 characters, never equal to an id. */
export function newBookingToken(): string {
  return randomBytes(32).toString('base64url');
}

export function newOperationId(): string {
  return crypto.randomUUID();
}

export function newAttemptId(): string {
  return crypto.randomUUID();
}

/** Bearer comparison for `/api/bookings/{id}/*` (C11) — constant time. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Length alone is not a secret here; the token length is fixed by policy.
    return false;
  }
  return timingSafeEqual(left, right);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** C9: the create route requires a uuid `Idempotency-Key`. */
export function isValidIdempotencyKey(key: string): boolean {
  return UUID.test(key.trim());
}
