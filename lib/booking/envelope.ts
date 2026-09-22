// C3 — the one booking response envelope.
//
// `delivery.calendar` mirrors `bookings.calendar_state` in **every** state,
// `pending` included (REV13-02), but `pending` is returned only by the read
// surfaces: a create 201 is issued only after T2 (`created`) or T2′ (`failed`)
// resolved the column, and a reschedule/cancel/repair 200 likewise. That split
// is a *consequence* of the create-success predicate (C6.4a), not a second
// rule, so the impossible combination throws rather than shipping a body the
// client contract forbids.

import { deliverySummaryFor, type DeliverySummary } from '../notify/ledger';
import type { BookingStore } from './store';
import type { BookingRow, CalendarState } from './rows';

export type DeliveryCalendarState = CalendarState | 'skipped';

export type DeliveryErrors = {
  email?: 'gmail_send_failed' | 'host_not_connected';
  calendar?: 'calendar_insert_failed' | 'host_not_connected';
};

export type DeliveryEnvelope = {
  email: DeliverySummary;
  calendar: DeliveryCalendarState;
  errors?: DeliveryErrors;
};

export type PublicBookingBody = {
  id: string;
  token: string;
  ownerSlug: string;
  eventSlug: string;
  eventTypeId: string;
  start: string;
  end: string;
  status: string;
  revision: number;
  hostFirstName: string;
  invitee: { name: string; email: string };
  rescheduledFrom?: string;
  notes?: string;
};

export type BookingEnvelope = {
  booking: PublicBookingBody;
  delivery: DeliveryEnvelope;
};

export type EnvelopeMeta = {
  ownerSlug: string;
  eventSlug: string;
  hostFirstName: string;
};

/** Which response this envelope is for; `pending` is legal only on `read`. */
export type Surface = 'read' | 'create' | 'lifecycle';

export async function buildEnvelope(
  store: BookingStore,
  row: BookingRow,
  meta: EnvelopeMeta,
  surface: Surface,
  errors?: DeliveryErrors,
): Promise<BookingEnvelope> {
  const email = await deliverySummaryFor(store, row.id, row.revision, row.latestAction);
  const calendar: DeliveryCalendarState = row.calendarState;

  if (calendar === 'pending' && surface !== 'read') {
    // C6.4a CF-1 makes this unreachable: `pending` holds exactly on rows whose
    // creation is unfinalized, and those are never answered 201/200.
    throw new Error(
      `calendar_state='pending' cannot appear on a ${surface} envelope for ${row.id}`,
    );
  }

  return {
    booking: bookingBody(row, meta),
    delivery: {
      email,
      calendar,
      // `pending` is never an error and never populates `errors` (C3).
      ...(errors !== undefined && Object.keys(errors).length > 0 ? { errors } : {}),
    },
  };
}

export function bookingBody(row: BookingRow, meta: EnvelopeMeta): PublicBookingBody {
  return {
    id: row.id,
    token: row.token,
    ownerSlug: meta.ownerSlug,
    eventSlug: meta.eventSlug,
    eventTypeId: row.eventTypeId,
    start: row.start,
    end: row.end,
    status: row.status,
    revision: row.revision,
    hostFirstName: meta.hostFirstName,
    invitee: { name: row.inviteeName, email: row.inviteeEmail },
    ...(row.rescheduledFrom === null ? {} : { rescheduledFrom: row.rescheduledFrom }),
    ...(row.notes === null ? {} : { notes: row.notes }),
  };
}
