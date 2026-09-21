// Month-window arithmetic for the booking picker. Months are 'YYYY-MM' in the
// **displayed time zone** (BOOK-FE-09): the initial month, the getSlots window,
// the day grouping, and month-boundary recovery all use the same IANA zone, so
// a start that is Oct 1 on the invitee's wall clock is listed under October
// and found by the October query. UTC is not special-cased — `timeZone: 'UTC'`
// simply reproduces the old UTC behaviour. All arithmetic is Intl-based (no
// third-party date library). The adapter clamps the window to the clock and
// filters elapsed starts.

const MONTH = /^(\d{4})-(\d{2})$/;

function partsOf(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Some ICU builds render midnight as "24" with hour12:false; h23 avoids it.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

// Offset (ms) of `timeZone` at `date`: local wall-clock minus UTC.
function offsetAt(date: Date, timeZone: string): number {
  const p = partsOf(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - date.getTime();
}

// UTC instant of local midnight on `year-month-day` in `timeZone`. Take the
// UTC guess, correct by the zone's offset at that instant, then re-derive the
// offset once after correcting so a DST edge on the 1st is handled.
function localMidnightUtc(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, 0, 0, 0);
  const first = guess - offsetAt(new Date(guess), timeZone);
  const second = guess - offsetAt(new Date(first), timeZone);
  return new Date(second);
}

export function monthOf(date: Date, timeZone: string): string {
  const p = partsOf(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function parseMonth(month: string): { year: number; month: number } {
  const match = MONTH.exec(month);
  if (!match) {
    throw new Error(`month must be YYYY-MM, got ${month}`);
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

// Pure year-month arithmetic; no zone involved.
export function shiftMonth(month: string, delta: number): string {
  const parsed = parseMonth(month);
  const total = parsed.year * 12 + (parsed.month - 1) + delta;
  const year = Math.floor(total / 12);
  const m = (total % 12 + 12) % 12 + 1;
  return `${year}-${String(m).padStart(2, '0')}`;
}

// [local midnight of the 1st of `month`, local midnight of the 1st of the next
// month) in `timeZone`, as UTC ISO strings. This is a window of **start**
// instants; the lib/api adapter widens the backend's end bound (BOOK-FE-12).
export function monthWindow(
  month: string,
  timeZone: string,
): { timeMin: string; timeMax: string } {
  const parsed = parseMonth(month);
  const next = parseMonth(shiftMonth(month, 1));
  return {
    timeMin: localMidnightUtc(parsed.year, parsed.month, 1, timeZone).toISOString(),
    timeMax: localMidnightUtc(next.year, next.month, 1, timeZone).toISOString(),
  };
}

export function dateKey(iso: string, timeZone: string): string {
  const p = partsOf(new Date(iso), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

// Day controls carry the month so the picker is unambiguous ("Wed, Oct 1").
export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso));
}

export function formatLongDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

// Title of the local month (not of a UTC instant): format an instant safely
// inside the local month in the same zone.
export function formatMonthTitle(month: string, timeZone: string): string {
  const parsed = parseMonth(month);
  const midMonth = localMidnightUtc(parsed.year, parsed.month, 15, timeZone);
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'long',
    year: 'numeric',
  }).format(midMonth);
}
