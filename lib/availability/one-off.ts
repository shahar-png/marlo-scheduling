export type OneOffWindow = {
  date: string;
  start: string;
  end: string;
};

export type OneOffMeeting = {
  id: string;
  hostId: string;
  name: string;
  durationMinutes: number;
  timezone: string;
  windows: OneOffWindow[];
};

export type CreateOneOffMeetingInput = {
  hostId: string;
  name: string;
  durationMinutes: number;
  timezone: string;
  windows: OneOffWindow[];
};

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const meetings = new Map<string, OneOffMeeting>();

export function resetOneOffMeetings(): void {
  meetings.clear();
}

export function createOneOffMeeting(
  input: CreateOneOffMeetingInput,
): OneOffMeeting {
  const hostId = input.hostId.trim();
  const name = input.name.trim();
  const timezone = input.timezone.trim();

  if (!hostId) {
    throw new Error('hostId is required');
  }
  if (!name) {
    throw new Error('name is required');
  }
  if (!timezone) {
    throw new Error('timezone is required');
  }
  assertValidTimeZone(timezone);

  if (
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes <= 0
  ) {
    throw new Error('durationMinutes must be a positive integer');
  }

  if (!input.windows || input.windows.length === 0) {
    throw new Error('windows must not be empty');
  }

  const windows = input.windows.map((window) => normalizeWindow(window));

  const meeting: OneOffMeeting = {
    id: crypto.randomUUID(),
    hostId,
    name,
    durationMinutes: input.durationMinutes,
    timezone,
    windows,
  };
  meetings.set(meeting.id, meeting);
  return cloneMeeting(meeting);
}

export function getOneOffMeeting(id: string): OneOffMeeting | null {
  const found = meetings.get(id);
  return found ? cloneMeeting(found) : null;
}

function normalizeWindow(window: OneOffWindow): OneOffWindow {
  const date = window.date.trim();
  if (!isValidCalendarDate(date)) {
    throw new Error('window date must be YYYY-MM-DD');
  }
  if (!LOCAL_TIME.test(window.start) || !LOCAL_TIME.test(window.end)) {
    throw new Error('window start and end must be HH:MM');
  }
  if (window.start >= window.end) {
    throw new Error('window start must be before end');
  }
  return {
    date,
    start: window.start,
    end: window.end,
  };
}

function isValidCalendarDate(value: string): boolean {
  const match = CALENDAR_DATE.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (
    utc.getUTCFullYear() === year &&
    utc.getUTCMonth() + 1 === month &&
    utc.getUTCDate() === day
  );
}

function assertValidTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    throw new Error('timezone must be a valid IANA time zone');
  }
}

function cloneMeeting(meeting: OneOffMeeting): OneOffMeeting {
  return {
    ...meeting,
    windows: meeting.windows.map((window) => ({ ...window })),
  };
}
