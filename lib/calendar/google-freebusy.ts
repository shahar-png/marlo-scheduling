import type {
  BusyWindow,
  CalendarEventDelete,
  CalendarEventInput,
  CalendarEventPatch,
  CalendarProvider,
  CreatedCalendarEvent,
  FreeBusyQuery,
} from './provider';

export type RecordedCalendarEvent = CalendarEventInput & { id: string };

export type RecordedCalendarPatch = CalendarEventPatch & { id: string };

export type FixtureCalendarProvider = CalendarProvider & {
  createdEvents: RecordedCalendarEvent[];
  patchedEvents: RecordedCalendarPatch[];
  deletedEventIds: string[];
};

export type GoogleBusyInterval = {
  start: string;
  end: string;
};

export type GoogleFreeBusyFixture = {
  calendars: Record<
    string,
    {
      busy?: GoogleBusyInterval[];
    }
  >;
};

export function mapGoogleFreeBusyFixture(
  fixture: GoogleFreeBusyFixture,
  calendarId: string,
): BusyWindow[] {
  const calendar = fixture.calendars[calendarId];
  const busy = calendar?.busy ?? [];
  return busy.map((window) => ({
    start: window.start,
    end: window.end,
  }));
}

export function createFixtureCalendarProvider(
  fixture: GoogleFreeBusyFixture,
): FixtureCalendarProvider {
  const createdEvents: RecordedCalendarEvent[] = [];
  const patchedEvents: RecordedCalendarPatch[] = [];
  const deletedEventIds: string[] = [];
  return {
    createdEvents,
    patchedEvents,
    deletedEventIds,
    async freeBusy(query: FreeBusyQuery): Promise<BusyWindow[]> {
      return mapGoogleFreeBusyFixture(fixture, query.calendarId);
    },
    async createEvent(event: CalendarEventInput): Promise<CreatedCalendarEvent> {
      const created: RecordedCalendarEvent = {
        ...event,
        attendees: event.attendees?.map((attendee) => ({ ...attendee })),
        id: `mock-event-${createdEvents.length + 1}`,
      };
      createdEvents.push(created);
      return { id: created.id };
    },
    async updateEvent(event: CalendarEventPatch): Promise<CreatedCalendarEvent> {
      const eventId = event.eventId.trim();
      if (!eventId) {
        throw new Error('eventId is required');
      }
      const patched: RecordedCalendarPatch = {
        ...event,
        eventId,
        attendees: event.attendees?.map((attendee) => ({ ...attendee })),
        id: eventId,
      };
      patchedEvents.push(patched);
      return { id: eventId };
    },
    async deleteEvent(event: CalendarEventDelete): Promise<void> {
      const eventId = event.eventId.trim();
      if (!eventId) {
        throw new Error('eventId is required');
      }
      deletedEventIds.push(eventId);
    },
  };
}
