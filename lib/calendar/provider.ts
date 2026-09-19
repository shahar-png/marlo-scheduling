export type BusyWindow = {
  start: string;
  end: string;
};

export type FreeBusyQuery = {
  calendarId: string;
  timeMin: string;
  timeMax: string;
};

export type CalendarAttendee = {
  email: string;
  displayName?: string;
};

export type CalendarEventInput = {
  calendarId: string;
  start: string;
  end: string;
  summary: string;
  attendees?: CalendarAttendee[];
};

export type CalendarEventPatch = {
  calendarId: string;
  eventId: string;
  start: string;
  end: string;
  summary?: string;
  attendees?: CalendarAttendee[];
};

export type CalendarEventDelete = {
  calendarId: string;
  eventId: string;
};

export type CreatedCalendarEvent = {
  id: string;
};

export interface CalendarProvider {
  freeBusy(query: FreeBusyQuery): Promise<BusyWindow[]>;
  createEvent(event: CalendarEventInput): Promise<CreatedCalendarEvent>;
  updateEvent(event: CalendarEventPatch): Promise<CreatedCalendarEvent>;
  deleteEvent(event: CalendarEventDelete): Promise<void>;
}
