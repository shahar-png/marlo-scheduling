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
    // Clamp the lower bound to the clock so a current-month query never asks
    // the slot engine for starts that have already elapsed.
    const minMs = Math.max(requestedMin, now().getTime());
    if (minMs >= maxMs) {
      // Empty-range guard (BOOK-FE-05): the whole window has elapsed. Never
      // send an inverted range to the backend; empty availability instead.
      return { times: [] };
    }
    const query = new URLSearchParams({
      timeMin: new Date(minMs).toISOString(),
      timeMax: new Date(maxMs).toISOString(),
    });
    const response = await transport({
      method: 'GET',
      path: `/api/event-types/${encodeURIComponent(input.slug)}/available-times?${query}`,
    });
    if (response.status !== 200) {
      throw new ApiError(response.status, errorMessage(response.body));
    }
    // Fresh clock on resolve (BOOK-FE-06): a slow response must not offer a
    // start that elapsed while the request was in flight.
    const resolvedNow = now().getTime();
    return {
      times: normalizeTimes(response.body).filter(
        (slot) => Date.parse(slot.start) >= resolvedNow,
      ),
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
    // Exactly one request per call — no retry loop. The backend has no
    // idempotency key (DIVERGENCES.md), so a retry could double-book.
    const response = await transport({
      method: 'POST',
      path: `/api/event-types/${encodeURIComponent(input.slug)}/bookings`,
      body: {
        start: input.start,
        invitee: { name: input.invitee.name, email: input.invitee.email },
      },
    });
    if (response.status === 201) {
      const booking = mapBooking(bookingOf(response.body));
      if (!booking) {
        return { ok: false, code: UNKNOWN_ERROR, status: 201 };
      }
      return { ok: true, booking };
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
  invitee: { name: string; email: string };
};

// Booking `id` is the confirmation token (`/b/{token}`); no second column.
export function mapBooking(booking: unknown): PublicBooking | null {
  if (!isRecord(booking)) {
    return null;
  }
  const invitee = isRecord(booking.invitee) ? booking.invitee : {};
  if (typeof booking.id !== 'string' || typeof booking.start !== 'string') {
    return null;
  }
  return {
    token: booking.id,
    start: booking.start,
    end: typeof booking.end === 'string' ? booking.end : '',
    status: typeof booking.status === 'string' ? booking.status : '',
    invitee: {
      name: typeof invitee.name === 'string' ? invitee.name : '',
      email: typeof invitee.email === 'string' ? invitee.email : '',
    },
  };
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
