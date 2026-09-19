import type { NotificationMode } from '../availability/event-type';

export type NotificationAction = 'create' | 'reschedule' | 'cancel';
export type NotificationChannel = 'calendar' | 'email';

export type NotificationLogEntry = {
  id: string;
  bookingId: string;
  action: NotificationAction;
  mode: NotificationMode;
  channel: NotificationChannel;
  providerMessageId?: string;
  createdAt: string;
};

export type RecordNotificationInput = {
  bookingId: string;
  action: NotificationAction;
  mode: NotificationMode;
  channel: NotificationChannel;
  providerMessageId?: string;
};

const entries: NotificationLogEntry[] = [];

export function resetNotificationLog(): void {
  entries.length = 0;
}

export function recordNotification(
  input: RecordNotificationInput,
): NotificationLogEntry {
  const bookingId = input.bookingId.trim();
  if (!bookingId) {
    throw new Error('bookingId is required');
  }

  const entry: NotificationLogEntry = {
    id: crypto.randomUUID(),
    bookingId,
    action: input.action,
    mode: input.mode,
    channel: input.channel,
    createdAt: new Date().toISOString(),
  };
  const providerMessageId = input.providerMessageId?.trim();
  if (providerMessageId) {
    entry.providerMessageId = providerMessageId;
  }
  entries.push(entry);
  return { ...entry };
}

export function listNotificationLog(bookingId?: string): NotificationLogEntry[] {
  const filtered = bookingId
    ? entries.filter((entry) => entry.bookingId === bookingId)
    : entries;
  return filtered.map((entry) => ({ ...entry }));
}
