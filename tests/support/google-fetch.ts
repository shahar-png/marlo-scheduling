// A fake `fetch` that speaks Google Calendar v3 and Gmail v1 over the **same**
// in-memory model the mock adapter uses (`lib/google/mock-calendar.ts`).
//
// That sharing is the whole point of AC-12's parity matrix and AC-25(g): the
// live adapter and the mock adapter are run against one state machine, so any
// difference the tests observe is a difference in the *adapters*, never in two
// hand-written doubles that drifted apart. Every collision mode, scripted
// failure, and held insert the mock supports is therefore available to the live
// adapter too, unchanged.
//
// Nothing here touches the network: the transport is a plain function, and
// `tests/support/fetch-guard.ts` stays armed throughout.

import {
  AlreadyExistsError,
  AvailabilityUnknownError,
  CalendarError,
  PreconditionFailedError,
} from '../../lib/google/errors';
import type { FetchLike, FetchResponseLike } from '../../lib/google/live-calendar';
import {
  MARLO_ATTEMPT_ID,
  MARLO_BOOKING_ID,
  MARLO_OP_GEN,
  type CalendarEvent,
  type CalendarListItem,
  type SendUpdates,
} from '../../lib/google/calendar';
import type { MockCalendar } from '../../lib/google/mock-calendar';

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export type GmailCall = { raw: string; authorization: string | undefined };

export type GoogleFetch = FetchLike & {
  /** Every Gmail send this transport saw, in order. */
  readonly gmail: GmailCall[];
  /** Queue one Gmail status; `null` clears the queue. */
  failNextGmail(status: number | null): void;
  /** Make the next Gmail call throw — a transport failure (ambiguous, C6.0). */
  throwNextGmail(): void;
};

/**
 * Wraps a {@link MockCalendar} in Google's REST shape. Errors travel back the
 * way Google sends them — a status plus an `error.message` body — so the live
 * adapter's own `classifyCalendarError` does the deciding, exactly as it would
 * against the real API.
 */
export function createGoogleFetch(calendar: MockCalendar): GoogleFetch {
  const gmail: GmailCall[] = [];
  const gmailStatuses: number[] = [];
  let gmailThrows = 0;

  const fetchImpl = (async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith(GMAIL_SEND)) {
      return sendGmail(init);
    }
    if (!url.startsWith(CALENDAR_API)) {
      throw new Error(`google-fetch: unexpected URL ${url}`);
    }
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter((part) => part !== '');
    // …/calendar/v3/calendars/{calendarId}/events[/{eventId}]
    const calendarIndex = segments.indexOf('calendars');
    const calendarId = decodeURIComponent(segments[calendarIndex + 1] ?? '');
    const eventId =
      segments.length > calendarIndex + 3
        ? decodeURIComponent(segments[calendarIndex + 3])
        : null;
    const sendUpdates = (parsed.searchParams.get('sendUpdates') ?? 'none') as SendUpdates;
    const ifMatch = headerOf(init?.headers, 'if-match');

    try {
      if (method === 'POST' && eventId === null) {
        return ok(eventBody(await insertFrom(parsed, init, calendarId, sendUpdates)));
      }
      if (method === 'GET' && eventId !== null) {
        const event = await calendar.get({ calendarId, eventId });
        return event === null
          ? errorResponse(404, 'Not Found')
          : ok(eventBody(event));
      }
      if (method === 'PATCH' && eventId !== null) {
        const body = jsonOf(init?.body);
        const patched = await calendar.patch({
          calendarId,
          eventId,
          ifMatch: ifMatch ?? '',
          sendUpdates,
          ...(dateTimeOf(body.start) === null ? {} : { start: dateTimeOf(body.start) as string }),
          ...(dateTimeOf(body.end) === null ? {} : { end: dateTimeOf(body.end) as string }),
          ...(typeof body.summary === 'string' ? { summary: body.summary } : {}),
          ...(opGenOf(body) === null ? {} : { opGen: opGenOf(body) as string }),
        });
        return ok(eventBody(patched));
      }
      if (method === 'DELETE' && eventId !== null) {
        const outcome = await calendar.remove({
          calendarId,
          eventId,
          ifMatch: ifMatch ?? '',
          sendUpdates,
        });
        return outcome === 'absent' ? errorResponse(410, 'Gone') : noContent();
      }
      if (method === 'GET' && eventId === null) {
        const timeZone = parsed.searchParams.get('timeZone');
        const items = await calendar.list({
          calendarId,
          timeMin: parsed.searchParams.get('timeMin') ?? '',
          timeMax: parsed.searchParams.get('timeMax') ?? '',
          ...(timeZone === null ? {} : { timeZone }),
        });
        return ok({ items: items.map(listItemBody) });
      }
    } catch (error) {
      return calendarFailure(error);
    }
    throw new Error(`google-fetch: unsupported ${method} ${url}`);
  }) as GoogleFetch;

  async function insertFrom(
    parsed: URL,
    init: Parameters<FetchLike>[1],
    calendarId: string,
    sendUpdates: SendUpdates,
  ): Promise<CalendarEvent> {
    void parsed;
    const body = jsonOf(init?.body);
    const priv = privateOf(body);
    const attendees = Array.isArray(body.attendees)
      ? body.attendees
          .filter((entry): entry is Record<string, unknown> => isRecord(entry))
          .map((entry) => ({
            email: String(entry.email ?? ''),
            ...(typeof entry.displayName === 'string'
              ? { displayName: entry.displayName }
              : {}),
          }))
      : undefined;
    return calendar.insert({
      calendarId,
      id: String(body.id ?? ''),
      start: dateTimeOf(body.start) ?? '',
      end: dateTimeOf(body.end) ?? '',
      summary: String(body.summary ?? ''),
      bookingId: priv[MARLO_BOOKING_ID] ?? '',
      attemptId: priv[MARLO_ATTEMPT_ID] ?? '',
      sendUpdates,
      ...(attendees === undefined ? {} : { attendees }),
    });
  }

  function sendGmail(init: Parameters<FetchLike>[1]): FetchResponseLike {
    if (gmailThrows > 0) {
      gmailThrows -= 1;
      throw new Error('gmail transport failure');
    }
    const body = jsonOf(init?.body);
    gmail.push({
      raw: String(body.raw ?? ''),
      authorization: headerOf(init?.headers, 'authorization'),
    });
    const status = gmailStatuses.shift() ?? 200;
    return status === 200 ? ok({}) : errorResponse(status, `gmail ${status}`);
  }

  Object.defineProperty(fetchImpl, 'gmail', { value: gmail });
  fetchImpl.failNextGmail = (status: number | null) => {
    if (status === null) {
      gmailStatuses.length = 0;
      return;
    }
    gmailStatuses.push(status);
  };
  fetchImpl.throwNextGmail = () => {
    gmailThrows += 1;
  };
  return fetchImpl;
}

/**
 * Maps a model-level failure back to the wire. A `CalendarError` with no status
 * is a transport failure at Google, so it is **thrown** rather than answered —
 * the live adapter must classify it `ambiguous` from the throw, exactly as it
 * would a socket error (C6.0).
 */
function calendarFailure(error: unknown): FetchResponseLike {
  if (error instanceof AlreadyExistsError) {
    return errorResponse(409, error.message || 'duplicate');
  }
  if (error instanceof PreconditionFailedError) {
    return errorResponse(412, error.message || 'precondition_failed');
  }
  if (error instanceof AvailabilityUnknownError) {
    return errorResponse(500, error.message);
  }
  if (error instanceof CalendarError) {
    if (error.status === null) {
      throw error;
    }
    return errorResponse(error.status, error.message);
  }
  throw error;
}

function ok(body: unknown): FetchResponseLike {
  return { status: 200, json: async () => body };
}

function noContent(): FetchResponseLike {
  return { status: 204, json: async () => null };
}

function errorResponse(status: number, message: string): FetchResponseLike {
  return { status, json: async () => ({ error: { message } }) };
}

function eventBody(event: CalendarEvent): Record<string, unknown> {
  return {
    id: event.id,
    status: event.status,
    etag: event.etag,
    start: { dateTime: event.start },
    end: { dateTime: event.end },
    ...(event.summary === undefined ? {} : { summary: event.summary }),
    extendedProperties: { private: privateProperties(event) },
  };
}

function listItemBody(item: CalendarListItem): Record<string, unknown> {
  const bounds = item.allDay
    ? { start: { date: item.start.slice(0, 10) }, end: { date: item.end.slice(0, 10) } }
    : { start: { dateTime: item.start }, end: { dateTime: item.end } };
  return {
    id: item.id,
    status: item.status,
    etag: item.etag,
    ...bounds,
    ...(item.summary === undefined ? {} : { summary: item.summary }),
    ...(item.transparency === undefined ? {} : { transparency: item.transparency }),
    extendedProperties: { private: privateProperties(item) },
  };
}

function privateProperties(
  item: { marloBookingId?: string; marloAttemptId?: string; marloOpGen?: string },
): Record<string, string> {
  return {
    ...(item.marloBookingId === undefined ? {} : { [MARLO_BOOKING_ID]: item.marloBookingId }),
    ...(item.marloAttemptId === undefined ? {} : { [MARLO_ATTEMPT_ID]: item.marloAttemptId }),
    ...(item.marloOpGen === undefined ? {} : { [MARLO_OP_GEN]: item.marloOpGen }),
  };
}

function jsonOf(body: string | undefined): Record<string, unknown> {
  if (body === undefined) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function headerOf(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) {
      return value;
    }
  }
  return undefined;
}

function dateTimeOf(value: unknown): string | null {
  return isRecord(value) && typeof value.dateTime === 'string' ? value.dateTime : null;
}

function opGenOf(body: Record<string, unknown>): string | null {
  const priv = privateOf(body);
  return priv[MARLO_OP_GEN] ?? null;
}

function privateOf(body: Record<string, unknown>): Record<string, string> {
  const extended = body.extendedProperties;
  if (!isRecord(extended) || !isRecord(extended.private)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(extended.private)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
