import {
  EMAIL_CONFIRMATION,
  getEventType,
  ONE_ON_ONE,
  resolveNotificationMode,
  type EventType,
  type NotificationMode,
} from '../availability/event-type';
import { getAvailabilitySchedule } from '../availability/schedule';
import { listAvailableTimes } from '../availability/slots';
import type {
  BusyWindow,
  CalendarAttendee,
  CalendarProvider,
} from '../calendar/provider';
import { dispatchBookingNotification } from '../notify/dispatch';
import type { EmailProvider } from '../notify/email';
import { getBookingEmailProvider } from '../notify/email-runtime';
import { cancelReminderJobs } from './reminders';

export const BOOKING_CONFIRMED = 'confirmed' as const;
export const BOOKING_CANCELLED = 'cancelled' as const;

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
  constructor(message = 'slot_unavailable') {
    super(message);
    this.name = 'BookingConflictError';
  }
}

const bookings = new Map<string, Booking>();
const slotLocks = new Map<string, Promise<void>>();

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

export function hostBookingsAsBusy(hostId: string): BusyWindow[] {
  return listConfirmedBookingsForHost(hostId).map((booking) => ({
    start: booking.start,
    end: booking.end,
  }));
}

export function createBooking(input: CreateBookingInput): Booking {
  const invitee = normalizeInvitee(input.invitee);
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    throw new BookingValidationError('start must be a valid ISO-8601 instant');
  }
  if (input.eventType.kind !== ONE_ON_ONE) {
    throw new BookingValidationError(
      `kind must be "${ONE_ON_ONE}"; ${input.eventType.kind} bookings are rejected`,
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
    const schedule = getAvailabilitySchedule(
      input.eventType.availabilityScheduleId,
    );
    if (!schedule) {
      throw new BookingNotFoundError('availability schedule not found');
    }

    const end = new Date(
      startMs + input.eventType.durationMinutes * 60_000,
    ).toISOString();

    const times = await listAvailableTimes({
      eventType: input.eventType,
      schedule,
      timeMin: start,
      timeMax: end,
      provider: input.provider,
      calendarId: input.calendarId,
      extraBusy: hostBookingsAsBusy(input.eventType.hostId),
    });

    if (!times.includes(start)) {
      throw new BookingConflictError();
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
  return cancelled;
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
  const previous = slotLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  slotLocks.set(
    key,
    previous.catch(() => undefined).then(() => current),
  );
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (slotLocks.get(key) === current) {
      slotLocks.delete(key);
    }
  }
}
