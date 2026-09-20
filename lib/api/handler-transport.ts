import { GET as bookingGET } from '../../app/api/bookings/[id]/route';
import { GET as availableTimesGET } from '../../app/api/event-types/[slug]/available-times/route';
import { POST as bookingsPOST } from '../../app/api/event-types/[slug]/bookings/route';
import { readJson, type ApiRequest, type ApiResponse, type Transport } from './transport';

// Transport that dispatches to the existing route handlers in-process (no
// HTTP, no server). Used by the adapter tests so `getSlots` / `createBooking`
// are exercised against the real booking service.

const ORIGIN = 'http://localhost';

const AVAILABLE_TIMES = /^\/api\/event-types\/([^/]+)\/available-times(?:\?.*)?$/;
const BOOKINGS = /^\/api\/event-types\/([^/]+)\/bookings$/;
const BOOKING = /^\/api\/bookings\/([^/]+)$/;

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

async function dispatch(request: ApiRequest): Promise<Response> {
  const url = new URL(request.path, ORIGIN);
  const pathname = url.pathname;

  if (request.method === 'GET') {
    const times = request.path.match(AVAILABLE_TIMES);
    if (times) {
      return availableTimesGET(new Request(url), {
        params: Promise.resolve({ slug: decodeURIComponent(times[1]) }),
      });
    }
    const booking = pathname.match(BOOKING);
    if (booking) {
      return bookingGET(new Request(url), {
        params: Promise.resolve({ id: decodeURIComponent(booking[1]) }),
      });
    }
  }

  if (request.method === 'POST') {
    const bookings = pathname.match(BOOKINGS);
    if (bookings) {
      return bookingsPOST(
        new Request(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(request.body ?? {}),
        }),
        { params: Promise.resolve({ slug: decodeURIComponent(bookings[1]) }) },
      );
    }
  }

  return Response.json({ error: 'route not found' }, { status: 404 });
}
