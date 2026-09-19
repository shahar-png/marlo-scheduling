export type CalendarDate = {
  year: number;
  month: number;
  day: number;
};

export function zonedParts(
  instant: Date,
  timeZone: string,
): CalendarDate & { hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);

  const read = (type: string): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new Error(`missing ${type} in zoned date`);
    }
    return Number(value);
  };

  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

export function calendarDateOfInstant(
  instant: Date,
  timeZone: string,
): CalendarDate {
  const parts = zonedParts(instant, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function addCalendarDays(
  date: CalendarDate,
  days: number,
): CalendarDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  };
}

export function compareCalendarDates(a: CalendarDate, b: CalendarDate): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

export function weekdayOfCalendarDate(date: CalendarDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

export function parseHourMinute(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(':').map(Number);
  return { hour, minute };
}

export function zonedLocalToUtc(
  date: CalendarDate,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0);
  let instant = new Date(guess);
  instant = new Date(guess - zoneOffsetMs(instant, timeZone));
  const offset = zoneOffsetMs(instant, timeZone);
  const adjusted = new Date(guess - offset);
  if (zoneOffsetMs(adjusted, timeZone) !== offset) {
    return new Date(guess - zoneOffsetMs(adjusted, timeZone));
  }
  return adjusted;
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}
