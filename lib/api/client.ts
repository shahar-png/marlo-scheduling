import { encodePathSegment } from './public-path';
import { fetchTransport, type Transport } from './transport';
import {
  ApiError,
  SESSION_FULL,
  SLOT_UNAVAILABLE,
  UNKNOWN_ERROR,
  type BookingApi,
  type Clock,
  type CreateBookingInput,
  type CreateBookingResult,
  type GetSlotsInput,
  type PublicBooking,
  type Slot,
  type SlotsResult,
} from './types';

// Public booking adapters (handoff §3.1 / §7 → repo routes). Repo truths:
//   GET  /api/event-types/:slug/available-times?timeMin&timeMax → { times }
//   POST /api/event-types/:slug/bookings { start, invitee }     → 201 { booking } | 409 { error }
//   GET  /api/bookings/:id                                      → 200 { booking } | 404
// The past-slot cutoff (AC-7) lives here with an injectable clock; the backend
// keeps accepting historical fixture starts. `now` is a function and is read
// fresh at each decision point (request clamp, response filter, submit).
//
// Request paths (BOOK-FE-19): the event-slug segment is built through the
// shared `encodePathSegment`, never interpolated raw. A slug the encoder
// rejects (`intro#follow-up`, `a/b`, …) never reaches the backend — the path
// would be split on the delimiter and hit a different or missing event.

const defaultClock: Clock = () => new Date();

export type ApiClientOptions = {
  transport?: Transport;
  now?: Clock;
};

export type ApiClient = BookingApi & {
  getBooking(token: string): Promise<PublicBooking | null>;
};

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const transport = options.transport ?? fetchTransport;
  const clientClock = options.now ?? defaultClock;

  async function getSlots(input: GetSlotsInput): Promise<SlotsResult> {
    const now = input.now ?? clientClock;
    const requestedMin = Date.parse(input.timeMin);
    const maxMs = Date.parse(input.timeMax);
    if (!Number.isFinite(requestedMin) || !Number.isFinite(maxMs)) {
      throw new ApiError(400, 'timeMin and timeMax must be ISO-8601 instants');
    }
    // Unrepresentable slug: no public page, no request — empty availability.
    const slugSegment = encodePathSegment(input.slug);
    if (slugSegment === null) {
      return { times: [] };
    }
    // Clamp the lower bound to the clock so a current-month query never asks
    // the slot engine for starts that have already elapsed.
    const minMs = Math.max(requestedMin, now().getTime());
    if (minMs >= maxMs) {
      // Empty-range guard (BOOK-FE-05): the whole window has elapsed. Never
      // send an inverted range to the backend; empty availability instead.
      // Keyed off the ORIGINAL timeMax — the widening below must not
      // un-elapse a window that is over.
      return { times: [] };
    }
    // End-bound widening (BOOK-FE-12): the caller's window is a range of
    // starts, but the slot engine excludes any meeting whose *end* exceeds
    // timeMax (lib/availability/slots.ts). Send timeMax + duration so a
    // start inside the local month whose meeting ends after local month-end
    // is still returned; filter back to `start < timeMax` on resolve.
    const durationMs = Math.max(0, input.durationMinutes) * 60_000;
    const backendMaxMs = maxMs + durationMs;
    const query = new URLSearchParams({
      timeMin: new Date(minMs).toISOString(),
      timeMax: new Date(backendMaxMs).toISOString(),
    });
    const response = await transport({
      method: 'GET',
      path: `/api/event-types/${slugSegment}/available-times?${query}`,
    });
    if (response.status !== 200) {
      throw new ApiError(response.status, errorMessage(response.body));
    }
    // Fresh clock on resolve (BOOK-FE-06): a slow response must not offer a
    // start that elapsed while the request was in flight.
    // The `start < timeMax` filter uses the original logical bound so the
    // widening never leaks a start belonging to the next month.
    const resolvedNow = now().getTime();
    return {
      times: normalizeTimes(response.body).filter((slot) => {
        const startMs = Date.parse(slot.start);
        return startMs >= resolvedNow && startMs < maxMs;
      }),
    };
  }

  async function createBooking(
    input: CreateBookingInput,
  ): Promise<CreateBookingResult> {
    const now = input.now ?? clientClock;
    const startMs = Date.parse(input.start);
    // Elapsed recheck before touching the backend: same typed result as a
    // 409 slot_unavailable so the UI has one recovery path.
    if (!Number.isFinite(startMs) || startMs < now().getTime()) {
      return { ok: false, code: SLOT_UNAVAILABLE };
    }
    // Unrepresentable slug: never a request whose path would be split on
    // `#` / `?` / `/` — an `unknown`-coded failure with zero backend calls.
    const slugSegment = encodePathSegment(input.slug);
    if (slugSegment === null) {
      return { ok: false, code: UNKNOWN_ERROR };
    }
    // Exactly one request per call — no retry loop. Retry safety comes from the
    // C9 `Idempotency-Key`, which the caller owns together with the payload it
    // was minted for; the owner-scoped route requires it.
    const ownerSegment =
      input.ownerSlug === undefined ? null : encodePathSegment(input.ownerSlug);
    if (input.ownerSlug !== undefined && ownerSegment === null) {
      return { ok: false, code: UNKNOWN_ERROR };
    }
    const path =
      ownerSegment === null
        ? `/api/event-types/${slugSegment}/bookings`
        : `/api/owners/${ownerSegment}/event-types/${slugSegment}/bookings`;
    const response = await transport({
      method: 'POST',
      path,
      body: {
        start: input.start,
        invitee: { name: input.invitee.name, email: input.invitee.email },
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      },
      ...(input.idempotencyKey === undefined
        ? {}
        : { headers: { 'idempotency-key': input.idempotencyKey } }),
    });
    // Only 201 is create success — a committed booking must never reach the
    // form's failure path (REV8-02).
    if (response.status === 201) {
      const booking = mapBooking(bookingOf(response.body));
      if (!booking) {
        return { ok: false, code: UNKNOWN_ERROR, status: 201 };
      }
      const delivery = mapDelivery(response.body);
      return { ok: true, booking: delivery === undefined ? booking : { ...booking, delivery } };
    }
    if (response.status === 409) {
      const error = errorMessage(response.body);
      if (error === SLOT_UNAVAILABLE || error === SESSION_FULL) {
        return { ok: false, code: error };
      }
      // Unrecognised 409 body: never coerce to slot_unavailable.
      return { ok: false, code: UNKNOWN_ERROR, status: 409, error };
    }
    return {
      ok: false,
      code: UNKNOWN_ERROR,
      status: response.status,
      error: errorMessage(response.body),
    };
  }

  async function getBooking(token: string): Promise<PublicBooking | null> {
    const response = await transport({
      method: 'GET',
      path: `/api/bookings/${encodeURIComponent(token)}`,
    });
    if (response.status === 404) {
      return null;
    }
    if (response.status !== 200) {
      throw new ApiError(response.status, errorMessage(response.body));
    }
    return mapBooking(bookingOf(response.body));
  }

  return { getSlots, createBooking, getBooking };
}

export type RepoBooking = {
  id: string;
  start: string;
  end: string;
  status: string;
  eventTypeId: string;
  invitee: { name: string; email: string };
};

// C11 — `token` is mapped from `booking.token`, explicitly and separately from
// `booking.id`. A legacy fixture row (the retained `/api/event-types/*` and
// `/api/links/*` paths, which C10/C6.9 keep outside the C6 contract) carries no
// `token` column; for those, and only those, the id still serves as the token so
// the fixture surfaces keep working.
export function mapBooking(booking: unknown): PublicBooking | null {
  if (!isRecord(booking)) {
    return null;
  }
  const invitee = isRecord(booking.invitee) ? booking.invitee : {};
  if (typeof booking.id !== 'string' || typeof booking.start !== 'string') {
    return null;
  }
  const token = typeof booking.token === 'string' ? booking.token : booking.id;
  const mapped: PublicBooking = {
    id: booking.id,
    token,
    start: booking.start,
    end: typeof booking.end === 'string' ? booking.end : '',
    status: typeof booking.status === 'string' ? booking.status : '',
    eventTypeId:
      typeof booking.eventTypeId === 'string' ? booking.eventTypeId : '',
    invitee: {
      name: typeof invitee.name === 'string' ? invitee.name : '',
      email: typeof invitee.email === 'string' ? invitee.email : '',
    },
  };
  if (typeof booking.ownerSlug === 'string') {
    mapped.ownerSlug = booking.ownerSlug;
  }
  if (typeof booking.eventSlug === 'string') {
    mapped.eventSlug = booking.eventSlug;
  }
  if (typeof booking.revision === 'number') {
    mapped.revision = booking.revision;
  }
  if (typeof booking.hostFirstName === 'string') {
    mapped.hostFirstName = booking.hostFirstName;
  }
  return mapped;
}

/** C3 — carries `delivery` through unchanged, `pending` included (REV13-02). */
export function mapDelivery(body: unknown): BookingDelivery | undefined {
  if (!isRecord(body) || !isRecord(body.delivery)) {
    return undefined;
  }
  const delivery = body.delivery;
  const email = delivery.email;
  const calendar = delivery.calendar;
  if (typeof email !== 'string' || typeof calendar !== 'string') {
    return undefined;
  }
  const mapped: BookingDelivery = {
    email: email as BookingDelivery['email'],
    calendar: calendar as BookingDelivery['calendar'],
  };
  if (isRecord(delivery.errors)) {
    const errors: { email?: string; calendar?: string } = {};
    if (typeof delivery.errors.email === 'string') {
      errors.email = delivery.errors.email;
    }
    if (typeof delivery.errors.calendar === 'string') {
      errors.calendar = delivery.errors.calendar;
    }
    mapped.errors = errors;
  }
  return mapped;
}

function normalizeTimes(body: unknown): Slot[] {
  const times = isRecord(body) && Array.isArray(body.times) ? body.times : [];
  const slots: Slot[] = [];
  for (const entry of times) {
    if (typeof entry === 'string') {
      slots.push({ start: entry });
    } else if (isRecord(entry) && typeof entry.start === 'string') {
      const slot: Slot = { start: entry.start };
      if (typeof entry.spots_remaining === 'number') {
        slot.spotsRemaining = entry.spots_remaining;
      }
      slots.push(slot);
    }
  }
  return slots;
}

function bookingOf(body: unknown): unknown {
  return isRecord(body) ? body.booking : undefined;
}

function errorMessage(body: unknown): string {
  return isRecord(body) && typeof body.error === 'string' ? body.error : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// Production client helpers: fetch the existing /api/... routes.
const productionClient = createApiClient();

export const getSlots = productionClient.getSlots;
export const createBooking = productionClient.createBooking;
export const getBooking = productionClient.getBooking;
