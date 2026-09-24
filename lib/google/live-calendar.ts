// Live Google Calendar adapter over an **injected** `fetch` (AC-7, AC-12
// parity, AC-25(g)). It is behaviourally identical to the mock adapter:
// client-supplied ids, `etag` on every response, `If-Match` on every mutation
// of an existing event, 412 → `PreconditionFailedError`, 409 →
// `AlreadyExistsError`, 404/410 → `null` on `get` and `absent` on delete.
//
// Reads are **fail-closed** (C7): a non-2xx page, an item without `start`/`end`,
// or an error mid-pagination throws `AvailabilityUnknownError`, which the API
// maps to 503 `availability_unknown` — never to "free".

import {
  AlreadyExistsError,
  AvailabilityUnknownError,
  CalendarError,
  HostNotConnectedError,
  PreconditionFailedError,
  classifyCalendarError,
  ALREADY_EXISTS,
  APPLIED,
  PRECONDITION_FAILED,
} from './errors';
import {
  MARLO_ATTEMPT_ID,
  MARLO_BOOKING_ID,
  MARLO_OP_GEN,
  privateProps,
  type CalendarClient,
  type CalendarEvent,
  type CalendarListItem,
  type DeleteEventInput,
  type DeleteOutcome,
  type GetEventInput,
  type InsertEventInput,
  type ListEventsInput,
  type PatchEventInput,
} from './calendar';
import { zonedLocalToUtc } from '../availability/timezone';

const API = 'https://www.googleapis.com/calendar/v3';
const MAX_RESULTS = 250;
const NOT_FOUND = new Set([404, 410]);

export type FetchResponseLike = {
  status: number;
  json(): Promise<unknown>;
};

export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

export type LiveCalendarOptions = {
  fetch: FetchLike;
  /** Resolves a bearer token; throws `HostNotConnectedError` when absent. */
  accessToken: () => Promise<string>;
};

export function createLiveCalendar(options: LiveCalendarOptions): CalendarClient {
  async function authorizedHeaders(): Promise<Record<string, string>> {
    const token = await options.accessToken();
    if (!token) {
      throw new HostNotConnectedError();
    }
    return {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    };
  }

  async function call(
    url: string,
    init: { method: string; headers?: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: unknown }> {
    const headers = { ...(await authorizedHeaders()), ...(init.headers ?? {}) };
    let response: FetchResponseLike;
    try {
      response = await options.fetch(url, { ...init, headers });
    } catch (error) {
      // Network error / timeout: ambiguous by C6.0 — the request may have run.
      throw new CalendarError('ambiguous', null, messageOf(error));
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  function raiseFor(status: number, body: unknown): never {
    const klass = classifyCalendarError(status);
    if (klass === ALREADY_EXISTS) {
      throw new AlreadyExistsError(errorMessage(body) || 'duplicate');
    }
    if (klass === PRECONDITION_FAILED) {
      throw new PreconditionFailedError(errorMessage(body) || 'precondition_failed');
    }
    throw new CalendarError(klass, status, errorMessage(body) || `calendar_${status}`);
  }

  return {
    async insert(input: InsertEventInput): Promise<CalendarEvent> {
      const query = new URLSearchParams({ sendUpdates: input.sendUpdates });
      const { status, body } = await call(
        `${API}/calendars/${encodeURIComponent(input.calendarId)}/events?${query}`,
        {
          method: 'POST',
          body: JSON.stringify({
            // The client-supplied id is what makes a replay idempotent by
            // observation (C6.2).
            id: input.id,
            summary: input.summary,
            start: { dateTime: input.start },
            end: { dateTime: input.end },
            ...(input.attendees ? { attendees: input.attendees.map(toGoogleAttendee) } : {}),
            extendedProperties: {
              private: privateProps({
                bookingId: input.bookingId,
                attemptId: input.attemptId,
              }),
            },
          }),
        },
      );
      if (classifyCalendarError(status) !== APPLIED) {
        raiseFor(status, body);
      }
      return parseEvent(body, input.start, input.end);
    },

    async get(input: GetEventInput): Promise<CalendarEvent | null> {
      const { status, body } = await call(
        `${API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}`,
        { method: 'GET' },
      );
      if (NOT_FOUND.has(status)) {
        // Absence of an event — never resolution of an attempt (C6.3b).
        return null;
      }
      if (classifyCalendarError(status) !== APPLIED) {
        raiseFor(status, body);
      }
      const event = parseEvent(body);
      return event.status === 'cancelled' ? null : event;
    },

    async patch(input: PatchEventInput): Promise<CalendarEvent> {
      const query = new URLSearchParams({ sendUpdates: input.sendUpdates });
      const patch: Record<string, unknown> = {};
      if (input.start !== undefined) {
        patch.start = { dateTime: input.start };
      }
      if (input.end !== undefined) {
        patch.end = { dateTime: input.end };
      }
      if (input.summary !== undefined) {
        patch.summary = input.summary;
      }
      if (input.attendees !== undefined) {
        patch.attendees = input.attendees.map(toGoogleAttendee);
      }
      if (input.opGen !== undefined) {
        patch.extendedProperties = { private: { [MARLO_OP_GEN]: input.opGen } };
      }
      const { status, body } = await call(
        `${API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?${query}`,
        {
          method: 'PATCH',
          // The only provider-side fence the contract offers (C6.3c).
          headers: { 'if-match': input.ifMatch },
          body: JSON.stringify(patch),
        },
      );
      if (classifyCalendarError(status) !== APPLIED) {
        raiseFor(status, body);
      }
      return parseEvent(body, input.start, input.end);
    },

    async remove(input: DeleteEventInput): Promise<DeleteOutcome> {
      const query = new URLSearchParams({ sendUpdates: input.sendUpdates });
      const { status, body } = await call(
        `${API}/calendars/${encodeURIComponent(input.calendarId)}/events/${encodeURIComponent(input.eventId)}?${query}`,
        {
          method: 'DELETE',
          headers: { 'if-match': input.ifMatch },
        },
      );
      if (NOT_FOUND.has(status)) {
        return 'absent';
      }
      if (classifyCalendarError(status) !== APPLIED) {
        raiseFor(status, body);
      }
      return 'deleted';
    },

    async list(input: ListEventsInput): Promise<CalendarListItem[]> {
      const items: CalendarListItem[] = [];
      let pageToken: string | undefined;
      do {
        const query = new URLSearchParams({
          timeMin: input.timeMin,
          timeMax: input.timeMax,
          // Recurring series must be expanded or an occupying occurrence is
          // invisible to the availability read (C7).
          singleEvents: 'true',
          showDeleted: 'false',
          maxResults: String(MAX_RESULTS),
        });
        if (pageToken) {
          query.set('pageToken', pageToken);
        }
        let page: { status: number; body: unknown };
        try {
          page = await call(
            `${API}/calendars/${encodeURIComponent(input.calendarId)}/events?${query}`,
            { method: 'GET' },
          );
        } catch (error) {
          // An error mid-pagination is fail-closed, not a short list.
          throw new AvailabilityUnknownError(messageOf(error));
        }
        if (classifyCalendarError(page.status) !== APPLIED) {
          throw new AvailabilityUnknownError(`events.list ${page.status}`);
        }
        const parsed = parsePage(page.body, input.timeZone);
        items.push(...parsed.items);
        pageToken = parsed.nextPageToken;
      } while (pageToken);
      return items;
    },
  };
}

function parsePage(
  body: unknown,
  timeZone: string | undefined,
): { items: CalendarListItem[]; nextPageToken?: string } {
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new AvailabilityUnknownError('events.list body is not parseable');
  }
  const items = body.items.map((item) => parseListItem(item, timeZone));
  const nextPageToken =
    typeof body.nextPageToken === 'string' && body.nextPageToken !== ''
      ? body.nextPageToken
      : undefined;
  return nextPageToken === undefined ? { items } : { items, nextPageToken };
}

function parseListItem(item: unknown, timeZone: string | undefined): CalendarListItem {
  if (!isRecord(item)) {
    throw new AvailabilityUnknownError('events.list item is not an object');
  }
  const bounds = parseBounds(item, timeZone);
  const priv = privateOf(item);
  const parsed: CalendarListItem = {
    id: typeof item.id === 'string' ? item.id : '',
    status: item.status === 'cancelled' ? 'cancelled' : 'confirmed',
    start: bounds.start,
    end: bounds.end,
    etag: typeof item.etag === 'string' ? item.etag : '',
    ...(bounds.allDay ? { allDay: true } : {}),
  };
  if (typeof item.summary === 'string') {
    parsed.summary = item.summary;
  }
  if (item.transparency === 'transparent') {
    parsed.transparency = 'transparent';
  }
  if (typeof priv[MARLO_BOOKING_ID] === 'string') {
    parsed.marloBookingId = priv[MARLO_BOOKING_ID];
  }
  if (typeof priv[MARLO_ATTEMPT_ID] === 'string') {
    parsed.marloAttemptId = priv[MARLO_ATTEMPT_ID];
  }
  if (typeof priv[MARLO_OP_GEN] === 'string') {
    parsed.marloOpGen = priv[MARLO_OP_GEN];
  }
  return parsed;
}

function parseEvent(body: unknown, fallbackStart?: string, fallbackEnd?: string): CalendarEvent {
  if (!isRecord(body)) {
    throw new CalendarError('ambiguous', null, 'event body is not parseable');
  }
  const priv = privateOf(body);
  const start = dateTimeOf(body.start) ?? fallbackStart ?? '';
  const end = dateTimeOf(body.end) ?? fallbackEnd ?? '';
  // A 2xx whose body does not identify an event is **malformed**, and C6.0
  // classifies a malformed response as `ambiguous` — never as an applied
  // mutation. Coercing the missing fields to `''` let a body like `{}` finalize
  // a booking as `calendar_state='created'` with no verified event identity and
  // no usable etag for any later `If-Match` (REVIEW-05).
  if (typeof body.id !== 'string' || body.id === '') {
    throw new CalendarError('ambiguous', null, 'event body carries no id');
  }
  if (typeof body.etag !== 'string' || body.etag === '') {
    throw new CalendarError('ambiguous', null, 'event body carries no etag');
  }
  if (start === '' || end === '') {
    throw new CalendarError('ambiguous', null, 'event body carries no bounds');
  }
  const event: CalendarEvent = {
    id: body.id,
    status: body.status === 'cancelled' ? 'cancelled' : 'confirmed',
    start,
    end,
    etag: body.etag,
  };
  if (typeof body.summary === 'string') {
    event.summary = body.summary;
  }
  if (typeof priv[MARLO_BOOKING_ID] === 'string') {
    event.marloBookingId = priv[MARLO_BOOKING_ID];
  }
  if (typeof priv[MARLO_ATTEMPT_ID] === 'string') {
    event.marloAttemptId = priv[MARLO_ATTEMPT_ID];
  }
  if (typeof priv[MARLO_OP_GEN] === 'string') {
    event.marloOpGen = priv[MARLO_OP_GEN];
  }
  return event;
}

function parseBounds(
  item: Record<string, unknown>,
  timeZone: string | undefined,
): { start: string; end: string; allDay: boolean } {
  const startDateTime = dateTimeOf(item.start);
  const endDateTime = dateTimeOf(item.end);
  if (startDateTime !== null && endDateTime !== null) {
    return { start: startDateTime, end: endDateTime, allDay: false };
  }
  const startDate = dateOf(item.start);
  const endDate = dateOf(item.end);
  if (startDate !== null && endDate !== null) {
    // All-day bounds are converted in the host's timezone (C7).
    const zone = timeZone ?? 'UTC';
    return {
      start: midnightIn(startDate, zone),
      end: midnightIn(endDate, zone),
      allDay: true,
    };
  }
  // An item missing start/end is fail-closed, never skipped.
  throw new AvailabilityUnknownError('events.list item has no start/end');
}

/** An all-day `date` bound is local midnight in the host's zone (C7). */
function midnightIn(date: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    throw new AvailabilityUnknownError('unparseable all-day date');
  }
  return zonedLocalToUtc({ year, month, day }, 0, 0, timeZone).toISOString();
}

function dateTimeOf(value: unknown): string | null {
  if (isRecord(value) && typeof value.dateTime === 'string') {
    const parsed = Date.parse(value.dateTime);
    if (!Number.isFinite(parsed)) {
      throw new AvailabilityUnknownError('unparseable dateTime');
    }
    return new Date(parsed).toISOString();
  }
  return null;
}

function dateOf(value: unknown): string | null {
  if (isRecord(value) && typeof value.date === 'string') {
    return value.date;
  }
  return null;
}

function privateOf(item: Record<string, unknown>): Record<string, string> {
  const extended = item.extendedProperties;
  if (!isRecord(extended)) {
    return {};
  }
  const priv = extended.private;
  if (!isRecord(priv)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(priv)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

function toGoogleAttendee(attendee: { email: string; displayName?: string }): Record<string, string> {
  return attendee.displayName === undefined
    ? { email: attendee.email }
    : { email: attendee.email, displayName: attendee.displayName };
}

function errorMessage(body: unknown): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string') {
    return body.error.message;
  }
  return '';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
