const cancelledReminderJobs: string[] = [];

export function resetReminderJobs(): void {
  cancelledReminderJobs.length = 0;
}

export function cancelReminderJobs(bookingId: string): void {
  const id = bookingId.trim();
  if (!id) {
    return;
  }
  cancelledReminderJobs.push(id);
}

export function listCancelledReminderJobs(): string[] {
  return [...cancelledReminderJobs];
}
