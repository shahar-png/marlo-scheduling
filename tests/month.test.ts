import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dateKey,
  formatDay,
  formatMonthTitle,
  monthOf,
  monthWindow,
  shiftMonth,
} from '../app/(public)/[slug]/[event]/month';

// BOOK-FE-09: month helpers are time-zone aware and tested against named
// zones only (never the machine's local zone). Kiritimati (+14) and Pago Pago
// (−11) are fixed-offset; New York covers a DST edge; Kathmandu is +5:45.

describe('BOOK-FE-09 month helpers (Intl-based, tz-aware)', () => {
  it('monthOf: the year-month of an instant on the local wall clock', () => {
    const t = new Date('2026-09-30T10:30:00.000Z');
    assert.equal(monthOf(t, 'Pacific/Kiritimati'), '2026-10'); // Oct 1 00:30 local
    assert.equal(monthOf(t, 'UTC'), '2026-09');
    assert.equal(monthOf(new Date('2026-10-01T05:00:00.000Z'), 'Pacific/Pago_Pago'), '2026-09'); // Sep 30 18:00 local
    assert.equal(monthOf(new Date('2026-10-01T12:00:00.000Z'), 'Pacific/Pago_Pago'), '2026-10'); // Oct 1 01:00 local
    assert.equal(monthOf(new Date('2026-12-31T23:30:00.000Z'), 'Pacific/Kiritimati'), '2027-01');
    assert.equal(monthOf(new Date('2027-01-01T05:00:00.000Z'), 'America/New_York'), '2027-01');
    assert.equal(monthOf(new Date('2027-01-01T04:59:00.000Z'), 'America/New_York'), '2026-12');
  });

  it('monthWindow: [local midnight of the 1st, local midnight of the next 1st) as UTC', () => {
    assert.deepEqual(monthWindow('2026-10', 'Pacific/Kiritimati'), {
      timeMin: '2026-09-30T10:00:00.000Z',
      timeMax: '2026-10-31T10:00:00.000Z',
    });
    assert.deepEqual(monthWindow('2026-09', 'Pacific/Pago_Pago'), {
      timeMin: '2026-09-01T11:00:00.000Z',
      timeMax: '2026-10-01T11:00:00.000Z',
    });
    assert.deepEqual(monthWindow('2026-10', 'Pacific/Pago_Pago'), {
      timeMin: '2026-10-01T11:00:00.000Z',
      timeMax: '2026-11-01T11:00:00.000Z',
    });
    assert.deepEqual(monthWindow('2026-09', 'UTC'), {
      timeMin: '2026-09-01T00:00:00.000Z',
      timeMax: '2026-10-01T00:00:00.000Z',
    });
    assert.deepEqual(monthWindow('2026-09', 'Asia/Kathmandu'), {
      timeMin: '2026-08-31T18:15:00.000Z',
      timeMax: '2026-09-30T18:15:00.000Z',
    });
    // DST edge inside the month: EST on Mar 1, EDT on Apr 1.
    assert.deepEqual(monthWindow('2026-03', 'America/New_York'), {
      timeMin: '2026-03-01T05:00:00.000Z',
      timeMax: '2026-04-01T04:00:00.000Z',
    });
    assert.deepEqual(monthWindow('2026-11', 'America/New_York'), {
      timeMin: '2026-11-01T04:00:00.000Z',
      timeMax: '2026-12-01T05:00:00.000Z',
    });
    // Year boundary.
    assert.deepEqual(monthWindow('2026-12', 'Pacific/Kiritimati'), {
      timeMin: '2026-11-30T10:00:00.000Z',
      timeMax: '2026-12-31T10:00:00.000Z',
    });
  });

  it('monthWindow and monthOf agree: every instant inside a window maps back to that month', () => {
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC', 'America/New_York', 'Asia/Kathmandu']) {
      for (const month of ['2026-02', '2026-03', '2026-09', '2026-10', '2026-12']) {
        const { timeMin, timeMax } = monthWindow(month, tz);
        assert.equal(monthOf(new Date(timeMin), tz), month, `${tz} ${month} timeMin`);
        assert.equal(monthOf(new Date(Date.parse(timeMax) - 1), tz), month, `${tz} ${month} timeMax-1`);
        assert.equal(monthOf(new Date(timeMax), tz), shiftMonth(month, 1), `${tz} ${month} timeMax`);
      }
    }
  });

  it('shiftMonth is pure year-month arithmetic', () => {
    assert.equal(shiftMonth('2026-09', 1), '2026-10');
    assert.equal(shiftMonth('2026-12', 1), '2027-01');
    assert.equal(shiftMonth('2026-01', -1), '2025-12');
    assert.equal(shiftMonth('2026-09', -9), '2025-12');
    assert.equal(shiftMonth('2026-09', 15), '2027-12');
  });

  it('formatMonthTitle names the local month, not the month of a UTC instant', () => {
    assert.equal(formatMonthTitle('2026-10', 'Pacific/Kiritimati'), 'October 2026');
    assert.equal(formatMonthTitle('2026-09', 'Pacific/Pago_Pago'), 'September 2026');
    assert.equal(formatMonthTitle('2026-03', 'America/New_York'), 'March 2026');
    assert.equal(formatMonthTitle('2026-09', 'UTC'), 'September 2026');
  });

  it('dateKey / formatDay group and label by the displayed zone, month included', () => {
    const start = '2026-09-30T11:00:00.000Z';
    assert.equal(dateKey(start, 'Pacific/Kiritimati'), '2026-10-01');
    assert.equal(dateKey(start, 'UTC'), '2026-09-30');
    assert.equal(formatDay(start, 'Pacific/Kiritimati'), 'Thu, Oct 1');
    assert.equal(formatDay(start, 'UTC'), 'Wed, Sep 30');
    assert.equal(dateKey('2026-10-01T08:00:00.000Z', 'Pacific/Pago_Pago'), '2026-09-30');
  });
});
