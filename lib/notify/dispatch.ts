import {
  CALENDAR_INVITATION,
  EMAIL_CONFIRMATION,
  type NotificationMode,
} from '../availability/event-type';
import {
  BOOKING_CANCELLED,
  BOOKING_CONFIRMATION,
  BOOKING_RESCHEDULED,
  EMAIL_SUBJECTS,
  type EmailProvider,
  type EmailTemplate,
} from './email';
import {
  recordNotification,
  type NotificationAction,
  type NotificationLogEntry,
} from './log';

export type NotifyBooking = {
  id: string;
  calendarEventId: string;
  invitee: { email: string };
};

export type DispatchBookingNotificationInput = {
  booking: NotifyBooking;
  action: NotificationAction;
  mode: NotificationMode;
  emailProvider: EmailProvider;
};

const TEMPLATES: Record<NotificationAction, EmailTemplate> = {
  create: BOOKING_CONFIRMATION,
  reschedule: BOOKING_RESCHEDULED,
  cancel: BOOKING_CANCELLED,
};

export async function dispatchBookingNotification(
  input: DispatchBookingNotificationInput,
): Promise<NotificationLogEntry> {
  if (input.mode === EMAIL_CONFIRMATION) {
    const template = TEMPLATES[input.action];
    const sent = await input.emailProvider.send({
      to: input.booking.invitee.email,
      subject: EMAIL_SUBJECTS[template],
      template,
      bookingId: input.booking.id,
    });
    return recordNotification({
      bookingId: input.booking.id,
      action: input.action,
      mode: EMAIL_CONFIRMATION,
      channel: 'email',
      providerMessageId: sent.id,
    });
  }

  return recordNotification({
    bookingId: input.booking.id,
    action: input.action,
    mode: CALENDAR_INVITATION,
    channel: 'calendar',
    providerMessageId: input.booking.calendarEventId,
  });
}
