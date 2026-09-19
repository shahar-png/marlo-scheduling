import {
  CALENDAR_INVITATION,
  EMAIL_CONFIRMATION,
  getEventType,
  GROUP,
  ONE_ON_ONE,
  resolveNotificationMode,
  type EventType,
  type NotificationMode,
} from '../availability/event-type';
import { getOneOffMeeting, type OneOffMeeting } from '../availability/one-off';
import {
  getAvailabilitySchedule,
  type AvailabilitySchedule,
} from '../availability/schedule';
import {
  consumeSingleUseLink,
  getSingleUseLinkByToken,
  LINK_CONSUMED,
} from '../availability/single-use-link';
import { listAvailableTimes } from '../availability/slots';
import type {
  BusyWindow,
  CalendarAttendee,
  CalendarProvider,
} from '../calendar/provider';
import { dispatchBookingNotification } from '../notify/dispatch';
import type { EmailProvider } from '../notify/email';
import { getBookingEmailProvider } from '../notify/email-runtime';
import { deliverBookingWebhook } from '../webhooks/deliver';
import {
  BOOKING_CANCELED as WEBHOOK_BOOKING_CANCELED,
  BOOKING_CREATED as WEBHOOK_BOOKING_CREATED,
  BOOKING_RESCHEDULED as WEBHOOK_BOOKING_RESCHEDULED,
} from '../webhooks/subscription';
import { cancelReminderJobs } from './reminders';

export const BOOKING_CONFIRMED = 'confirmed' as const;
export const BOOKING_CANCELLED = 'cancelled' as const;
export const SLOT_UNAVAILABLE = 'slot_unavailable' as const;
export const SESSION_FULL = 'session_full' as const;

export type BookingStatus =
  | typeof BOOKING_CONFIRMED
  | typeof BOOKING_CANCELLED;

export type BookingInvitee = {
  name: string;
  email: string;
};

export type Booking = {
  id: string;
  eventTypeId: string;
  hostId: string;
  start: string;
  end: string;
  status: BookingStatus;
  invitee: BookingInvitee;
  calendarEventId: string;
  cancelReason?: string;
};

export type CreateBookingInput = {
  eventType: EventType;
  start: string;
  invitee: BookingInvitee;
  calendarEventId: string;
};

export type BookAvailableSlotInput = {
  eventType: EventType;
  start: string;
  invitee: BookingInvitee;
  provider: CalendarProvider;
  calendarId: string;
  emailProvider?: EmailProvider;
  oneOffMeeting?: OneOffMeeting;
};

export type BookSingleUseLinkInput = {
  token: string;
  start: string;
  invitee: BookingInvitee;
  provider: CalendarProvider;
  calendarId: string;
  emailProvider?: EmailProvider;
};

export type ListSingleUseAvailableTimesInput = {
  token: string;
  timeMin: string;
  timeMax: string;
  provider: CalendarProvider;
  calendarId: string;
};

export type RescheduleBookingInput = {
  bookingId: string;
  start: string;
  provider: CalendarProvider;
  calendarId: string;
  emailProvider?: EmailProvider;
};

export type CancelBookingInput = {
  bookingId: string;
  reason: string;
  provider: CalendarProvider;
  calendarId: string;
  emailProvider?: EmailProvider;
};

export class BookingValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'BookingValidationError';
  }
}

export class BookingNotFoundError extends Error {
  readonly status = 404;
  constructor(message: string) {
    super(message);
    this.name = 'BookingNotFoundError';
  }
}

export class BookingConflictError extends Error {
  readonly status = 409;
  constructor(message = SLOT_UNAVAILABLE) {
    super(message);
    this.name = 'BookingConflictError';
  }
}

export class SingleUseLinkConsumedError extends Error {
  readonly status = 410;
  constructor(message = 'link_consumed') {
    super(message);
    this.name = 'SingleUseLinkConsumedError';
  }
}

const bookings = new Map<string, Booking>();
const slotLocks = new Map<string, Promise<void>>();
const tokenLocks = new Map<string, Promise<void>>();

export function resetBookings(): void {
  bookings.clear();
  slotLocks.clear();
}

export function getBooking(id: string): Booking | null {
  const found = bookings.get(id);
  return found ? cloneBooking(found) : null;
}

export function listConfirmedBookingsForHost(hostId: string): Booking[] {
  return [...bookings.values()]
    .filter(
      (booking) =>
        booking.hostId === hostId && booking.status === BOOKING_CONFIRMED,
    )
    .map(cloneBooking);
}

export function hostBookingsAsBusy(
  hostId: string,
  options?: { excludeEventTypeId?: string },
): BusyWindow[] {
  return listConfirmedBookingsForHost(hostId)
    .filter((booking) => booking.eventTypeId !== options?.excludeEventTypeId)
    .map((booking) => ({
      start: booking.start,
      end: booking.end,
    }));
}

export function countConfirmedBookingsForSlot(
  eventTypeId: string,
  start: string,
): number {
  return [...bookings.values()].filter(
    (booking) =>
      booking.eventTypeId === eventTypeId &&
      booking.start === start &&
      booking.status === BOOKING_CONFIRMED,
  ).length;
}

export function listConfirmedStartsForEventType(eventTypeId: string): string[] {
  return [...bookings.values()]
    .filter(
      (booking) =>
        booking.eventTypeId === eventTypeId &&
        booking.status === BOOKING_CONFIRMED,
    )
    .map((booking) => booking.start);
}

export function createBooking(input: CreateBookingInput): Booking {
  const invitee = normalizeInvitee(input.invitee);
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    throw new BookingValidationError('start must be a valid ISO-8601 instant');
  }
  if (input.eventType.kind !== ONE_ON_ONE && input.eventType.kind !== GROUP) {
    throw new BookingValidationError(
      `kind must be "${ONE_ON_ONE}" or "${GROUP}"; ${input.eventType.kind} bookings are rejected`,
    );
  }
  if (
    !Number.isInteger(input.eventType.durationMinutes) ||
    input.eventType.durationMinutes <= 0
  ) {
    throw new BookingValidationError('durationMinutes must be a positive integer');
  }
  const calendarEventId = input.calendarEventId.trim();
  if (!calendarEventId) {
    throw new BookingValidationError('calendarEventId is required');
  }

  const start = new Date(startMs).toISOString();
  const end = new Date(
    startMs + input.eventType.durationMinutes * 60_000,
  ).toISOString();

  const booking: Booking = {
    id: crypto.randomUUID(),
    eventTypeId: input.eventType.id,
    hostId: input.eventType.hostId,
    start,
    end,
    status: BOOKING_CONFIRMED,
    invitee,
    calendarEventId,
  };
  bookings.set(booking.id, booking);
  return cloneBooking(booking);
}

export async function bookAvailableSlot(
  input: BookAvailableSlotInput,
): Promise<Booking> {
  const invitee = normalizeInvitee(input.invitee);
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    throw new BookingValidationError('start must be a valid ISO-8601 instant');
  }
  const start = new Date(startMs).toISOString();
  const lockKey = `${input.eventType.hostId}:${start}`;

  return withSlotLock(lockKey, async () => {
    const schedule = input.oneOffMeeting
      ? undefined
      : getAvailabilitySchedule(input.eventType.availabilityScheduleId) ??
        undefined;
    if (!input.oneOffMeeting && !schedule) {
      throw new BookingNotFoundError('availability schedule not found');
    }

    const end = new Date(
      startMs + input.eventType.durationMinutes * 60_000,
    ).toISOString();

    const extraBusy = hostBookingsAsBusy(
      input.eventType.hostId,
      input.eventType.kind === GROUP
        ? { excludeEventTypeId: input.eventType.id }
        : undefined,
    );

    const times = await listAvailableTimes({
      eventType: input.eventType,
      schedule,
      oneOffMeeting: input.oneOffMeeting,
      timeMin: start,
      timeMax: end,
      provider: input.provider,
      calendarId: input.calendarId,
      extraBusy,
    });

    if (!times.includes(start)) {
      throw new BookingConflictError(SLOT_UNAVAILABLE);
    }

    if (input.eventType.kind === GROUP) {
      const maxInvitees = input.eventType.maxInvitees;
      if (
        maxInvitees === undefined ||
        !Number.isInteger(maxInvitees) ||
        maxInvitees <= 0
      ) {
        throw new BookingValidationError('maxInvitees must be a positive integer');
      }
      if (countConfirmedBookingsForSlot(input.eventType.id, start) >= maxInvitees) {
        throw new BookingConflictError(SESSION_FULL);
      }
    }

    const mode = resolveNotificationMode(input.eventType.notificationMode);
    const created = await input.provider.createEvent({
      calendarId: input.calendarId,
      start,
      end,
      summary: input.eventType.name,
      ...inviteeAttendees(mode, invitee),
    });

    const booking = createBooking({
      eventType: input.eventType,
      start,
      invitee,
      calendarEventId: created.id,
    });
    await dispatchBookingNotification({
      booking,
      action: 'create',
      mode,
      emailProvider: input.emailProvider ?? getBookingEmailProvider(),
    });
    await deliverBookingWebhook({
      booking,
      event: WEBHOOK_BOOKING_CREATED,
    });
    return booking;
  });
}

export async function listSingleUseAvailableTimes(
  input: ListSingleUseAvailableTimesInput,
): Promise<string[]> {
  const resolved = resolveSingleUseTarget(input.token);
  return listAvailableTimes({
    eventType: resolved.eventType,
    schedule: resolved.schedule,
    oneOffMeeting: resolved.oneOffMeeting,
    timeMin: input.timeMin,
    timeMax: input.timeMax,
    provider: input.provider,
    calendarId: input.calendarId,
    extraBusy: hostBookingsAsBusy(resolved.eventType.hostId),
  });
}

export async function bookSingleUseLink(
  input: BookSingleUseLinkInput,
): Promise<Booking> {
  return withLock(tokenLocks, input.token, async () => {
    const resolved = resolveSingleUseTarget(input.token);
    const booking = await bookAvailableSlot({
      eventType: resolved.eventType,
      start: input.start,
      invitee: input.invitee,
      provider: input.provider,
      calendarId: input.calendarId,
      emailProvider: input.emailProvider,
      oneOffMeeting: resolved.oneOffMeeting,
    });
    consumeSingleUseLink(input.token, booking.id);
    return booking;
  });
}

export async function rescheduleBooking(
  input: RescheduleBookingInput,
): Promise<Booking> {
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    throw new BookingValidationError('start must be a valid ISO-8601 instant');
  }
  const start = new Date(startMs).toISOString();

  const existing = bookings.get(input.bookingId);
  if (!existing) {
    throw new BookingNotFoundError('booking not found');
  }
  if (existing.status !== BOOKING_CONFIRMED) {
    throw new BookingValidationError('only confirmed bookings can be rescheduled');
  }

  const lockKey = `${existing.hostId}:${start}`;

  return withSlotLock(lockKey, async () => {
    const current = bookings.get(input.bookingId);
    if (!current) {
      throw new BookingNotFoundError('booking not found');
    }
    if (current.status !== BOOKING_CONFIRMED) {
      throw new BookingValidationError(
        'only confirmed bookings can be rescheduled',
      );
    }

    const eventType = getEventType(current.eventTypeId);
    if (!eventType) {
      throw new BookingNotFoundError('event type not found');
    }
    const schedule = getAvailabilitySchedule(eventType.availabilityScheduleId);
    if (!schedule) {
      throw new BookingNotFoundError('availability schedule not found');
    }

    const end = new Date(
      startMs + eventType.durationMinutes * 60_000,
    ).toISOString();

    const extraBusy = listConfirmedBookingsForHost(current.hostId)
      .filter((booking) => booking.id !== current.id)
      .map((booking) => ({ start: booking.start, end: booking.end }));

    const times = await listAvailableTimes({
      eventType,
      schedule,
      timeMin: start,
      timeMax: end,
      provider: input.provider,
      calendarId: input.calendarId,
      extraBusy,
    });

    if (!times.includes(start)) {
      throw new BookingConflictError();
    }

    const mode = resolveNotificationMode(eventType.notificationMode);
    await input.provider.updateEvent({
      calendarId: input.calendarId,
      eventId: current.calendarEventId,
      start,
      end,
      summary: eventType.name,
      ...inviteeAttendees(mode, current.invitee),
    });

    current.start = start;
    current.end = end;
    cancelReminderJobs(current.id);
    const updated = cloneBooking(current);
    await dispatchBookingNotification({
      booking: updated,
      action: 'reschedule',
      mode,
      emailProvider: input.emailProvider ?? getBookingEmailProvider(),
    });
    await deliverBookingWebhook({
      booking: updated,
      event: WEBHOOK_BOOKING_RESCHEDULED,
    });
    return updated;
  });
}

export async function cancelBooking(
  input: CancelBookingInput,
): Promise<Booking> {
  const reason = input.reason.trim();
  if (!reason) {
    throw new BookingValidationError('cancel reason is required');
  }

  const booking = bookings.get(input.bookingId);
  if (!booking) {
    throw new BookingNotFoundError('booking not found');
  }
  if (booking.status !== BOOKING_CONFIRMED) {
    throw new BookingValidationError('only confirmed bookings can be cancelled');
  }

  await input.provider.deleteEvent({
    calendarId: input.calendarId,
    eventId: booking.calendarEventId,
  });

  booking.status = BOOKING_CANCELLED;
  booking.cancelReason = reason;
  cancelReminderJobs(booking.id);
  const cancelled = cloneBooking(booking);
  const eventType = getEventType(booking.eventTypeId);
  const mode = resolveNotificationMode(eventType?.notificationMode);
  await dispatchBookingNotification({
    booking: cancelled,
    action: 'cancel',
    mode,
    emailProvider: input.emailProvider ?? getBookingEmailProvider(),
  });
  await deliverBookingWebhook({
    booking: cancelled,
    event: WEBHOOK_BOOKING_CANCELED,
  });
  return cancelled;
}

function resolveSingleUseTarget(token: string): {
  eventType: EventType;
  schedule?: AvailabilitySchedule;
  oneOffMeeting?: OneOffMeeting;
} {
  const link = getSingleUseLinkByToken(token);
  if (!link) {
    throw new BookingNotFoundError('single-use link not found');
  }
  if (link.status === LINK_CONSUMED) {
    throw new SingleUseLinkConsumedError();
  }

  if (link.eventTypeId) {
    const eventType = getEventType(link.eventTypeId);
    if (!eventType) {
      throw new BookingNotFoundError('event type not found');
    }
    const schedule = getAvailabilitySchedule(eventType.availabilityScheduleId);
    if (!schedule) {
      throw new BookingNotFoundError('availability schedule not found');
    }
    return { eventType, schedule };
  }

  if (link.oneOffMeetingId) {
    const oneOffMeeting = getOneOffMeeting(link.oneOffMeetingId);
    if (!oneOffMeeting) {
      throw new BookingNotFoundError('one-off meeting not found');
    }
    return {
      eventType: eventTypeFromOneOff(oneOffMeeting),
      oneOffMeeting,
    };
  }

  throw new BookingValidationError('single-use link has no target');
}

function eventTypeFromOneOff(meeting: OneOffMeeting): EventType {
  return {
    id: meeting.id,
    hostId: meeting.hostId,
    slug: `one-off-${meeting.id}`,
    name: meeting.name,
    durationMinutes: meeting.durationMinutes,
    availabilityScheduleId: meeting.id,
    kind: ONE_ON_ONE,
    notificationMode: CALENDAR_INVITATION,
  };
}

function inviteeAttendees(
  mode: NotificationMode,
  invitee: BookingInvitee,
): { attendees?: CalendarAttendee[] } {
  if (mode === EMAIL_CONFIRMATION) {
    return {};
  }
  return {
    attendees: [{ email: invitee.email, displayName: invitee.name }],
  };
}

function normalizeInvitee(invitee: BookingInvitee): BookingInvitee {
  const name = invitee.name.trim();
  const email = invitee.email.trim();
  if (!name) {
    throw new BookingValidationError('invitee name is required');
  }
  if (!email) {
    throw new BookingValidationError('invitee email is required');
  }
  if (!email.includes('@')) {
    throw new BookingValidationError('invitee email is required');
  }
  return { name, email };
}

function cloneBooking(booking: Booking): Booking {
  const cloned: Booking = {
    ...booking,
    invitee: { ...booking.invitee },
  };
  if (booking.cancelReason !== undefined) {
    cloned.cancelReason = booking.cancelReason;
  }
  return cloned;
}

async function withSlotLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withLock(slotLocks, key, fn);
}

async function withLock<T>(
  locks: Map<string, Promise<void>>,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    key,
    previous.catch(() => undefined).then(() => current),
  );
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  }
}
