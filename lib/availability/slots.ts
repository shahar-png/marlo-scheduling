import type { EventType } from './event-type';
import type { OneOffMeeting } from './one-off';
import type { AvailabilitySchedule } from './schedule';
import type { BusyWindow, CalendarProvider } from '../calendar/provider';
import {
  addCalendarDays,
  calendarDateOfInstant,
  compareCalendarDates,
  parseHourMinute,
  weekdayOfCalendarDate,
  zonedLocalToUtc,
} from './timezone';

export type ListAvailableTimesInput = {
  eventType: Pick<EventType, 'durationMinutes'>;
  schedule?: AvailabilitySchedule;
  oneOffMeeting?: OneOffMeeting;
  timeMin: string;
  timeMax: string;
  provider: CalendarProvider;
  calendarId: string;
  extraBusy?: BusyWindow[];
};

export async function listAvailableTimes(
  input: ListAvailableTimesInput,
): Promise<string[]> {
  const timeMin = Date.parse(input.timeMin);
  const timeMax = Date.parse(input.timeMax);
  if (!Number.isFinite(timeMin) || !Number.isFinite(timeMax) || timeMin >= timeMax) {
    throw new Error('timeMin and timeMax must be a valid ISO range');
  }
  if (!input.oneOffMeeting && !input.schedule) {
    throw new Error('schedule or oneOffMeeting is required');
  }

  const calendarBusy = await input.provider.freeBusy({
    calendarId: input.calendarId,
    timeMin: input.timeMin,
    timeMax: input.timeMax,
  });
  const busy = [...calendarBusy, ...(input.extraBusy ?? [])];

  const durationMs = input.eventType.durationMinutes * 60_000;
  const times: string[] = [];

  const windows = input.oneOffMeeting
    ? expandOneOffWindows(input.oneOffMeeting)
    : expandWeeklyWindows(
        input.schedule!,
        new Date(timeMin),
        new Date(timeMax),
      );

  for (const window of windows) {
    for (
      let start = window.startMs;
      start + durationMs <= window.endMs;
      start += durationMs
    ) {
      const end = start + durationMs;
      if (start < timeMin || end > timeMax) {
        continue;
      }
      if (overlapsBusy(start, end, busy)) {
        continue;
      }
      times.push(new Date(start).toISOString());
    }
  }

  return times;
}

function expandWeeklyWindows(
  schedule: AvailabilitySchedule,
  timeMin: Date,
  timeMax: Date,
): { startMs: number; endMs: number }[] {
  const windows: { startMs: number; endMs: number }[] = [];
  let cursor = calendarDateOfInstant(timeMin, schedule.timezone);
  const last = calendarDateOfInstant(timeMax, schedule.timezone);

  while (compareCalendarDates(cursor, last) <= 0) {
    const weekday = weekdayOfCalendarDate(cursor);
    for (const window of schedule.windows) {
      if (window.weekday !== weekday) {
        continue;
      }
      const start = parseHourMinute(window.start);
      const end = parseHourMinute(window.end);
      windows.push({
        startMs: zonedLocalToUtc(
          cursor,
          start.hour,
          start.minute,
          schedule.timezone,
        ).getTime(),
        endMs: zonedLocalToUtc(
          cursor,
          end.hour,
          end.minute,
          schedule.timezone,
        ).getTime(),
      });
    }
    cursor = addCalendarDays(cursor, 1);
  }

  return windows;
}

function expandOneOffWindows(
  meeting: OneOffMeeting,
): { startMs: number; endMs: number }[] {
  return meeting.windows.map((window) => {
    const [year, month, day] = window.date.split('-').map(Number);
    const start = parseHourMinute(window.start);
    const end = parseHourMinute(window.end);
    const date = { year, month, day };
    return {
      startMs: zonedLocalToUtc(
        date,
        start.hour,
        start.minute,
        meeting.timezone,
      ).getTime(),
      endMs: zonedLocalToUtc(
        date,
        end.hour,
        end.minute,
        meeting.timezone,
      ).getTime(),
    };
  });
}

function overlapsBusy(
  startMs: number,
  endMs: number,
  busy: { start: string; end: string }[],
): boolean {
  return busy.some((window) => {
    const busyStart = Date.parse(window.start);
    const busyEnd = Date.parse(window.end);
    return startMs < busyEnd && busyStart < endMs;
  });
}
