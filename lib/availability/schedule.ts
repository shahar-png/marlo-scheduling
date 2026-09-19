export type WeekdayWindow = {
  weekday: number;
  start: string;
  end: string;
};

export type AvailabilitySchedule = {
  id: string;
  hostId: string;
  timezone: string;
  windows: WeekdayWindow[];
};

export type CreateAvailabilityScheduleInput = {
  hostId: string;
  timezone: string;
  windows: WeekdayWindow[];
};

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const schedules = new Map<string, AvailabilitySchedule>();

export function resetAvailabilitySchedules(): void {
  schedules.clear();
}

export function createAvailabilitySchedule(
  input: CreateAvailabilityScheduleInput,
): AvailabilitySchedule {
  const hostId = input.hostId.trim();
  const timezone = input.timezone.trim();
  if (!hostId) {
    throw new Error('hostId is required');
  }
  if (!timezone) {
    throw new Error('timezone is required');
  }
  assertValidTimeZone(timezone);

  if (!input.windows || input.windows.length === 0) {
    throw new Error('windows must not be empty');
  }

  const windows = input.windows.map((window) => normalizeWindow(window));

  const schedule: AvailabilitySchedule = {
    id: crypto.randomUUID(),
    hostId,
    timezone,
    windows,
  };
  schedules.set(schedule.id, schedule);
  return cloneSchedule(schedule);
}

export function getAvailabilitySchedule(
  id: string,
): AvailabilitySchedule | null {
  const found = schedules.get(id);
  return found ? cloneSchedule(found) : null;
}

function normalizeWindow(window: WeekdayWindow): WeekdayWindow {
  if (
    !Number.isInteger(window.weekday) ||
    window.weekday < 0 ||
    window.weekday > 6
  ) {
    throw new Error('weekday must be an integer 0 (Sunday) through 6 (Saturday)');
  }
  if (!LOCAL_TIME.test(window.start) || !LOCAL_TIME.test(window.end)) {
    throw new Error('window start and end must be HH:MM');
  }
  if (window.start >= window.end) {
    throw new Error('window start must be before end');
  }
  return {
    weekday: window.weekday,
    start: window.start,
    end: window.end,
  };
}

function assertValidTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('timezone must be a valid IANA time zone');
  }
}

function cloneSchedule(schedule: AvailabilitySchedule): AvailabilitySchedule {
  return {
    ...schedule,
    windows: schedule.windows.map((window) => ({ ...window })),
  };
}
