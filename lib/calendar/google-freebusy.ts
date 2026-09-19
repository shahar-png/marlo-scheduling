import type {
  BusyWindow,
  CalendarEventInput,
  CalendarProvider,
  CreatedCalendarEvent,
  FreeBusyQuery,
} from './provider';

export type RecordedCalendarEvent = CalendarEventInput & { id: string };

export type FixtureCalendarProvider = CalendarProvider & {
  createdEvents: RecordedCalendarEvent[];
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
  return {
    createdEvents,
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
  };
}
