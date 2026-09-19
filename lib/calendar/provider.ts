export type BusyWindow = {
  start: string;
  end: string;
};

export type FreeBusyQuery = {
  calendarId: string;
  timeMin: string;
  timeMax: string;
};

export interface CalendarProvider {
  freeBusy(query: FreeBusyQuery): Promise<BusyWindow[]>;
}
