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
  calendarIds?: string[];
  extraBusy?: BusyWindow[];
  /**
   * Candidate-start step (REV3-08). The public / owner-scoped / legacy routes
   * and the create route keep `incrementMinutes = durationMinutes` (BOOK-FE
   * behaviour unchanged); only the **authenticated reschedule** policy uses
   * `RESCHEDULE_SLOT_INCREMENT_MIN`, which is what makes an overlapping move
   * (09:00 → 09:15 for a 30-minute booking) actually generated rather than
   * merely un-blocked.
   */
  incrementMinutes?: number;
};

/** C12 — the authenticated reschedule grid, independent of the duration. */
export const RESCHEDULE_SLOT_INCREMENT_MIN = 15;

export function rescheduleIncrementFor(durationMinutes: number): number {
  return Math.min(RESCHEDULE_SLOT_INCREMENT_MIN, durationMinutes);
}

export type RescheduleCandidatesInput = Omit<ListAvailableTimesInput, 'incrementMinutes'> & {
  /** The booking's current start is never offered (an unchanged-time move). */
  excludeStart: string;
};

/**
 * The single generator behind `GET /api/bookings/{id}/available-times` **and**
 * the reschedule mutation's validation, so every offered slot is accepted and
 * nothing else is (C12 / C6.6).
 */
export async function rescheduleCandidates(
  input: RescheduleCandidatesInput,
): Promise<string[]> {
  const times = await listAvailableTimes({
    ...input,
    incrementMinutes: rescheduleIncrementFor(input.eventType.durationMinutes),
  });
  const excluded = new Date(Date.parse(input.excludeStart)).toISOString();
  return times.filter((start) => start !== excluded);
}

/**
 * Every start the reschedule grid generates in `[timeMin, timeMax)`, ignoring
 * occupancy. This is the *shape* half of `rescheduleCandidates` — the half that
 * depends only on the schedule and the increment — so the reschedule mutation
 * can reject an off-grid `start` before it reads anything (C6.6: "validated as
 * a candidate of the reschedule slot increment generator"). Occupancy stays
 * where it belongs: the authoritative locked re-check in T1.
 */
export function rescheduleGridStarts(input: {
  schedule: AvailabilitySchedule;
  durationMinutes: number;
  timeMin: string;
  timeMax: string;
}): string[] {
  return gridStarts({ ...input, incrementMinutes: rescheduleIncrementFor(input.durationMinutes) });
}

/** Every start a grid generates in `[timeMin, timeMax)`, ignoring occupancy. */
function gridStarts(input: {
  schedule: AvailabilitySchedule;
  durationMinutes: number;
  incrementMinutes: number;
  timeMin: string;
  timeMax: string;
}): string[] {
  const timeMin = Date.parse(input.timeMin);
  const timeMax = Date.parse(input.timeMax);
  const durationMs = input.durationMinutes * 60_000;
  const incrementMs = input.incrementMinutes * 60_000;
  const starts: string[] = [];

  for (const window of expandWeeklyWindows(
    input.schedule,
    new Date(timeMin),
    new Date(timeMax),
  )) {
    for (
      let start = window.startMs;
      start + durationMs <= window.endMs;
      start += incrementMs
    ) {
      if (start < timeMin || start + durationMs > timeMax) {
        continue;
      }
      starts.push(new Date(start).toISOString());
    }
  }
  return starts;
}

/**
 * True iff `start` is a slot the reschedule picker would offer for this
 * booking: on the grid, inside a schedule window, and not the booking's own
 * current start (an unchanged-time move is never a calendar call — C12).
 */
export function isRescheduleCandidateStart(input: {
  schedule: AvailabilitySchedule;
  durationMinutes: number;
  start: string;
  excludeStart: string;
}): boolean {
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    return false;
  }
  const iso = new Date(startMs).toISOString();
  if (iso === new Date(Date.parse(input.excludeStart)).toISOString()) {
    return false;
  }
  // One day either side covers any window the start could belong to.
  const day = 86_400_000;
  return rescheduleGridStarts({
    schedule: input.schedule,
    durationMinutes: input.durationMinutes,
    timeMin: new Date(startMs - day).toISOString(),
    timeMax: new Date(startMs + day).toISOString(),
  }).includes(iso);
}

/**
 * True iff `start` is a slot the **public** picker would offer: inside a
 * schedule window and on the duration-stepped grid the create route publishes.
 *
 * A create that checked only occupancy would accept any instant a caller typed
 * — a Sunday 02:07 booking, or one in the middle of a meeting — because an
 * unoccupied interval is not the same thing as an offered one (C6.4/C9).
 */
export function isPublicCandidateStart(input: {
  schedule: AvailabilitySchedule;
  durationMinutes: number;
  start: string;
}): boolean {
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    return false;
  }
  const day = 86_400_000;
  return gridStarts({
    schedule: input.schedule,
    durationMinutes: input.durationMinutes,
    incrementMinutes: input.durationMinutes,
    timeMin: new Date(startMs - day).toISOString(),
    timeMax: new Date(startMs + day).toISOString(),
  }).includes(new Date(startMs).toISOString());
}

/**
 * The one-off equivalent of {@link isPublicCandidateStart} (C10). A one-off
 * meeting publishes date-scoped windows rather than a weekly schedule, so the
 * link create gates on the meeting's own grid.
 */
export function isOneOffCandidateStart(input: {
  meeting: OneOffMeeting;
  start: string;
}): boolean {
  const startMs = Date.parse(input.start);
  if (!Number.isFinite(startMs)) {
    return false;
  }
  const durationMs = input.meeting.durationMinutes * 60_000;
  for (const window of expandOneOffWindows(input.meeting)) {
    for (
      let candidate = window.startMs;
      candidate + durationMs <= window.endMs;
      candidate += durationMs
    ) {
      if (candidate === startMs) {
        return true;
      }
    }
  }
  return false;
}

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

  const calendarIds = uniqueCalendarIds(input.calendarIds, input.calendarId);
  const calendarBusy: BusyWindow[] = [];
  for (const calendarId of calendarIds) {
    calendarBusy.push(
      ...(await input.provider.freeBusy({
        calendarId,
        timeMin: input.timeMin,
        timeMax: input.timeMax,
      })),
    );
  }
  const busy = [...calendarBusy, ...(input.extraBusy ?? [])];

  const durationMs = input.eventType.durationMinutes * 60_000;
  const incrementMs = (input.incrementMinutes ?? input.eventType.durationMinutes) * 60_000;
  if (incrementMs <= 0) {
    throw new Error('incrementMinutes must be a positive integer');
  }
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
      start += incrementMs
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

function uniqueCalendarIds(
  calendarIds: string[] | undefined,
  calendarId: string,
): string[] {
  const ids = calendarIds?.length ? calendarIds : [calendarId];
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique.length > 0 ? unique : [calendarId];
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
