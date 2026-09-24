import { GET as bookingGET } from '../../app/api/bookings/[id]/route';
import { GET as bookingTimesGET } from '../../app/api/bookings/[id]/available-times/route';
import { POST as reschedulePOST } from '../../app/api/bookings/[id]/reschedule/route';
import { POST as cancelPOST } from '../../app/api/bookings/[id]/cancel/route';
import { POST as notifyPOST } from '../../app/api/bookings/[id]/notify/route';
import { GET as availableTimesGET } from '../../app/api/event-types/[slug]/available-times/route';
import { POST as bookingsPOST } from '../../app/api/event-types/[slug]/bookings/route';
import { GET as ownerTimesGET } from '../../app/api/owners/[ownerSlug]/event-types/[eventSlug]/available-times/route';
import { POST as ownerBookingsPOST } from '../../app/api/owners/[ownerSlug]/event-types/[eventSlug]/bookings/route';
import { readJson, type ApiRequest, type ApiResponse, type Transport } from './transport';

// Transport that dispatches to the existing route handlers in-process (no
// HTTP, no server), so the UI tests exercise the **real** handlers rather than
// a mocked client (C12 / AC-21).
//
// Request headers are forwarded verbatim, because two of them are contract:
// the C9 `Idempotency-Key` on create and the C11 `Authorization: Bearer` on
// every `/api/bookings/{id}/*` call. A transport that dropped them would make
// the id/token split untestable.

const ORIGIN = 'http://localhost';

const AVAILABLE_TIMES = /^\/api\/event-types\/([^/]+)\/available-times(?:\?.*)?$/;
const BOOKINGS = /^\/api\/event-types\/([^/]+)\/bookings$/;
const OWNER_TIMES =
  /^\/api\/owners\/([^/]+)\/event-types\/([^/]+)\/available-times(?:\?.*)?$/;
const OWNER_BOOKINGS = /^\/api\/owners\/([^/]+)\/event-types\/([^/]+)\/bookings$/;
const BOOKING = /^\/api\/bookings\/([^/]+)$/;
const BOOKING_TIMES = /^\/api\/bookings\/([^/]+)\/available-times$/;
const RESCHEDULE = /^\/api\/bookings\/([^/]+)\/reschedule$/;
const CANCEL = /^\/api\/bookings\/([^/]+)\/cancel$/;
const NOTIFY = /^\/api\/bookings\/([^/]+)\/notify$/;

export function createHandlerTransport(): Transport & { calls: ApiRequest[] } {
  const calls: ApiRequest[] = [];
  const transport = (async (request: ApiRequest): Promise<ApiResponse> => {
    calls.push(request);
    const response = await dispatch(request);
    return { status: response.status, body: await readJson(response) };
  }) as Transport & { calls: ApiRequest[] };
  transport.calls = calls;
  return transport;
}

function get(url: URL, request: ApiRequest): Request {
  return new Request(url, { headers: { ...(request.headers ?? {}) } });
}

function post(url: URL, request: ApiRequest): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(request.headers ?? {}) },
    body: JSON.stringify(request.body ?? {}),
  });
}

const segment = (value: string): string => decodeURIComponent(value);

async function dispatch(request: ApiRequest): Promise<Response> {
  const url = new URL(request.path, ORIGIN);
  const pathname = url.pathname;

  if (request.method === 'GET') {
    const ownerTimes = request.path.match(OWNER_TIMES);
    if (ownerTimes) {
      return ownerTimesGET(get(url, request), {
        params: Promise.resolve({
          ownerSlug: segment(ownerTimes[1]),
          eventSlug: segment(ownerTimes[2]),
        }),
      });
    }
    const times = request.path.match(AVAILABLE_TIMES);
    if (times) {
      return availableTimesGET(get(url, request), {
        params: Promise.resolve({ slug: segment(times[1]) }),
      });
    }
    const bookingTimes = pathname.match(BOOKING_TIMES);
    if (bookingTimes) {
      return bookingTimesGET(get(url, request), {
        params: Promise.resolve({ id: segment(bookingTimes[1]) }),
      });
    }
    const booking = pathname.match(BOOKING);
    if (booking) {
      return bookingGET(get(url, request), {
        params: Promise.resolve({ id: segment(booking[1]) }),
      });
    }
  }

  if (request.method === 'POST') {
    const ownerBookings = pathname.match(OWNER_BOOKINGS);
    if (ownerBookings) {
      return ownerBookingsPOST(post(url, request), {
        params: Promise.resolve({
          ownerSlug: segment(ownerBookings[1]),
          eventSlug: segment(ownerBookings[2]),
        }),
      });
    }
    const bookings = pathname.match(BOOKINGS);
    if (bookings) {
      return bookingsPOST(post(url, request), {
        params: Promise.resolve({ slug: segment(bookings[1]) }),
      });
    }
    const reschedule = pathname.match(RESCHEDULE);
    if (reschedule) {
      return reschedulePOST(post(url, request), {
        params: Promise.resolve({ id: segment(reschedule[1]) }),
      });
    }
    const cancel = pathname.match(CANCEL);
    if (cancel) {
      return cancelPOST(post(url, request), {
        params: Promise.resolve({ id: segment(cancel[1]) }),
      });
    }
    const notify = pathname.match(NOTIFY);
    if (notify) {
      return notifyPOST(post(url, request), {
        params: Promise.resolve({ id: segment(notify[1]) }),
      });
    }
  }

  return Response.json({ error: 'route not found' }, { status: 404 });
}
