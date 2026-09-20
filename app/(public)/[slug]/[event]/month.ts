// Month-window arithmetic for the booking picker. Months are 'YYYY-MM'
// (UTC); the adapter clamps the window to the clock and filters elapsed starts.

const MONTH = /^(\d{4})-(\d{2})$/;

export function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function parseMonth(month: string): { year: number; month: number } {
  const match = MONTH.exec(month);
  if (!match) {
    throw new Error(`month must be YYYY-MM, got ${month}`);
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

export function shiftMonth(month: string, delta: number): string {
  const parsed = parseMonth(month);
  const date = new Date(Date.UTC(parsed.year, parsed.month - 1 + delta, 1));
  return monthOf(date);
}

export function monthWindow(month: string): { timeMin: string; timeMax: string } {
  const parsed = parseMonth(month);
  return {
    timeMin: new Date(Date.UTC(parsed.year, parsed.month - 1, 1)).toISOString(),
    timeMax: new Date(Date.UTC(parsed.year, parsed.month, 1)).toISOString(),
  };
}

export function dateKey(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function formatDay(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
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

export function formatMonthTitle(month: string): string {
  const parsed = parseMonth(month);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(new Date(Date.UTC(parsed.year, parsed.month - 1, 1)));
}
