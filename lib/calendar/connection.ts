export type CalendarConnection = {
  hostId: string;
  connected: boolean;
  destinationCalendarId: string | null;
};

const connections = new Map<string, CalendarConnection>();

export function resetCalendarConnections(): void {
  connections.clear();
}

export function connectHostCalendar(
  hostId: string,
  destinationCalendarId: string,
): CalendarConnection {
  const trimmedHostId = hostId.trim();
  const trimmedCalendarId = destinationCalendarId.trim();
  if (!trimmedHostId) {
    throw new Error('hostId is required');
  }
  if (!trimmedCalendarId) {
    throw new Error('destinationCalendarId is required');
  }

  const connection: CalendarConnection = {
    hostId: trimmedHostId,
    connected: true,
    destinationCalendarId: trimmedCalendarId,
  };
  connections.set(trimmedHostId, connection);
  return { ...connection };
}

export function getHostCalendarConnection(
  hostId: string,
): CalendarConnection | null {
  const found = connections.get(hostId);
  return found ? { ...found } : null;
}
