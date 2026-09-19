import { createFixtureCalendarProvider } from '../calendar/google-freebusy';
import type { CalendarProvider } from '../calendar/provider';
import type { GoogleFreeBusyFixture } from '../calendar/google-freebusy';
import fixture from '../../tests/fixtures/google-freebusy.json';

let injectedProvider: CalendarProvider | null = null;

export function setBookingCalendarProvider(
  provider: CalendarProvider | null,
): void {
  injectedProvider = provider;
}

export function getBookingCalendarProvider(): CalendarProvider {
  return (
    injectedProvider ??
    createFixtureCalendarProvider(fixture as GoogleFreeBusyFixture)
  );
}
