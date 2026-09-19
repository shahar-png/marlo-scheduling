import type { BusyWindow, CalendarProvider, FreeBusyQuery } from './provider';

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
): CalendarProvider {
  return {
    async freeBusy(query: FreeBusyQuery): Promise<BusyWindow[]> {
      return mapGoogleFreeBusyFixture(fixture, query.calendarId);
    },
  };
}
