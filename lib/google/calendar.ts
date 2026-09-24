// Google Calendar port (C6.2, C6.3c, C7).
//
// Every mutation this app issues is addressed by an **app-generated event id**
// in Google's accepted alphabet, so a replay is idempotent by observation
// (C6.2), and every insert body carries `marloAttemptId` so a reaped event
// names the one request that created it (C6.3a / REV6-01).
//
// Every mutation of an *existing* event carries `If-Match` and maps 412 to
// `PreconditionFailedError`, which is the only provider-side fence the Google
// contract offers (C6.3c). `get` maps 404/410 to `null` — absence of an event,
// never resolution of an attempt (C6.3b / REV5-01).

import type { AvailabilityUnknownError } from './errors';

export const MARLO_BOOKING_ID = 'marloBookingId' as const;
export const MARLO_ATTEMPT_ID = 'marloAttemptId' as const;
export const MARLO_OP_GEN = 'marloOpGen' as const;

export type SendUpdates = 'all' | 'none';

export type CalendarAttendee = {
  email: string;
  displayName?: string;
};

export type CalendarEvent = {
  id: string;
  status: 'confirmed' | 'cancelled';
  start: string;
  end: string;
  etag: string;
  summary?: string;
  transparency?: 'opaque' | 'transparent';
  attendees?: CalendarAttendee[];
  /** `extendedProperties.private.marloBookingId` — set on every Marlo write. */
  marloBookingId?: string;
  /** `extendedProperties.private.marloAttemptId` — set on every Marlo insert. */
  marloAttemptId?: string;
  marloOpGen?: string;
};

/** A raw `events.list` row, already normalised but not yet classified (C7). */
export type CalendarListItem = CalendarEvent & {
  /** True for an all-day `date` bound, converted in the host's timezone. */
  allDay?: boolean;
};

export type InsertEventInput = {
  calendarId: string;
  /** App-generated, durable before the call (C6.2). */
  id: string;
  start: string;
  end: string;
  summary: string;
  bookingId: string;
  attemptId: string;
  attendees?: CalendarAttendee[];
  sendUpdates: SendUpdates;
};

export type PatchEventInput = {
  calendarId: string;
  eventId: string;
  start?: string;
  end?: string;
  summary?: string;
  attendees?: CalendarAttendee[];
  sendUpdates: SendUpdates;
  /** Required: no mutation of an existing event is unconditioned (C6.3c). */
  ifMatch: string;
  /** Version-bump marker written by a takeover (C6.3c). */
  opGen?: string;
};

export type DeleteEventInput = {
  calendarId: string;
  eventId: string;
  ifMatch: string;
  sendUpdates: SendUpdates;
};

export type GetEventInput = {
  calendarId: string;
  eventId: string;
};

export type ListEventsInput = {
  calendarId: string;
  timeMin: string;
  timeMax: string;
  /** Host timezone, used to convert all-day `date` bounds (C7). */
  timeZone?: string;
};

export type DeleteOutcome = 'deleted' | 'absent';

export interface CalendarClient {
  /**
   * Creates the event under the supplied id. Throws `AlreadyExistsError` on
   * Google's 409 `duplicate`; the **op**'s outcome is then decided by `get`,
   * never by this status (C6.2).
   */
  insert(input: InsertEventInput): Promise<CalendarEvent>;
  /** `null` on 404/410 — the event is absent; no attempt is resolved. */
  get(input: GetEventInput): Promise<CalendarEvent | null>;
  patch(input: PatchEventInput): Promise<CalendarEvent>;
  /** 404/410 is a tolerated `absent`; 412 throws `PreconditionFailedError`. */
  remove(input: DeleteEventInput): Promise<DeleteOutcome>;
  /** Fail-closed: any unparseable page or item throws {@link AvailabilityUnknownError}. */
  list(input: ListEventsInput): Promise<CalendarListItem[]>;
}

/** Google's accepted id alphabet for client-supplied event ids (C6.2). */
const ID_ALPHABET = /^[a-v0-9]{5,1024}$/;

export function isValidCalendarEventId(id: string): boolean {
  return ID_ALPHABET.test(id);
}

/**
 * `marlo` + base32hex of a fresh uuid — inside Google's `[a-v0-9]{5,1024}`
 * alphabet, so the id can be supplied on `events.insert` (C6.2).
 */
export function newCalendarEventId(uuid: string = crypto.randomUUID()): string {
  const hex = uuid.replace(/-/g, '');
  let out = 'marlo';
  for (const char of hex) {
    // 0-9 stay; a-f map into the a-v range unchanged (they are all < 'v').
    out += char;
  }
  return out;
}

export function privateProps(event: {
  bookingId?: string;
  attemptId?: string;
  opGen?: string;
}): Record<string, string> {
  const props: Record<string, string> = {};
  if (event.bookingId !== undefined) {
    props[MARLO_BOOKING_ID] = event.bookingId;
  }
  if (event.attemptId !== undefined) {
    props[MARLO_ATTEMPT_ID] = event.attemptId;
  }
  if (event.opGen !== undefined) {
    props[MARLO_OP_GEN] = event.opGen;
  }
  return props;
}

/** An item is **managed** iff it carries `marloBookingId` (C7). */
export function isManaged(item: Pick<CalendarListItem, 'marloBookingId'>): boolean {
  return typeof item.marloBookingId === 'string' && item.marloBookingId !== '';
}

/** Cancelled items are never busy; `transparent` items are never busy (C7). */
export function isBusyCandidate(item: CalendarListItem): boolean {
  return item.status !== 'cancelled' && item.transparency !== 'transparent';
}
