// Shared route plumbing: one error mapping, one bearer check, one origin.

import {
  BookingNotFoundResponse,
  LifecycleError,
  TokenRequiredError,
  lifecycleResponse,
} from '../booking/errors';
import { AvailabilityUnknownError } from '../google/errors';
import { EmailAddressError } from '../email/address';
import { NotMigratedError } from '../db/index';
import { OutcomeUnresolvedError } from '../booking/store';
import { ReservedOwnerSlugError } from '../owners';
import { constantTimeEqual } from '../booking/ids';
import type { BookingRow } from '../booking/rows';

/** Maps every thrown contract error to its C3 status + body. */
export function errorResponse(error: unknown): Response | null {
  const mapped = lifecycleResponse(error);
  if (mapped !== null) {
    return Response.json(mapped.body, { status: mapped.status });
  }
  if (error instanceof AvailabilityUnknownError) {
    return Response.json({ error: 'availability_unknown' }, { status: 503 });
  }
  if (error instanceof OutcomeUnresolvedError) {
    return Response.json(
      { error: 'booking_outcome_unknown', retryAfterSeconds: 5 },
      { status: 503 },
    );
  }
  if (error instanceof EmailAddressError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ReservedOwnerSlugError) {
    return Response.json({ error: error.code }, { status: 404 });
  }
  if (error instanceof NotMigratedError) {
    return Response.json({ error: error.code }, { status: 503 });
  }
  return null;
}

export function jsonOrThrow(error: unknown): Response {
  const response = errorResponse(error);
  if (response !== null) {
    return response;
  }
  throw error;
}

/**
 * C11 — the token is the bearer credential and is never read from the query
 * string or the JSON body. A missing header is 401 `token_required`; a wrong
 * token or an unknown id is a uniform 404 `booking_not_found` (no enumeration).
 */
export function requireBookingToken(request: Request, row: BookingRow | null): BookingRow {
  const header = request.headers.get('authorization');
  if (header === null || !/^Bearer\s+/i.test(header)) {
    throw new TokenRequiredError();
  }
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (row === null || token === '' || !constantTimeEqual(token, row.token)) {
    throw new BookingNotFoundResponse();
  }
  return row;
}

/** Absolute origin of the issuing request — every email link is built from it. */
export function originOf(request: Request): string {
  try {
    return new URL(request.url).origin;
  } catch {
    return 'http://localhost';
  }
}

export function idempotencyKeyOf(request: Request): string | null {
  return request.headers.get('idempotency-key');
}

export async function readJsonBody<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

export function windowFrom(url: URL): { start: string; end: string } | null {
  const timeMin = url.searchParams.get('timeMin');
  const timeMax = url.searchParams.get('timeMax');
  if (timeMin === null || timeMax === null) {
    return null;
  }
  const min = Date.parse(timeMin);
  const max = Date.parse(timeMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return null;
  }
  return { start: new Date(min).toISOString(), end: new Date(max).toISOString() };
}

export { LifecycleError };
