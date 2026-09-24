// AC-5 (email safety) · AC-7 (fail-closed Google reads) · AC-8 / C7 (busy
// classification) · AC-14 (OAuth scopes + token encryption).
//
// These four all guard the same class of mistake: trusting input, or trusting
// an answer that did not arrive. A busy read that fails open double-books a
// host; a header that is not encoded lets an invitee name address the message.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EmailAddressError,
  assertNoHeaderInjection,
  assertSingleMailbox,
  isSingleMailbox,
} from '../lib/email/address';
import { buildMimeMessage, encodeHeaderValue, toGmailRaw } from '../lib/email/mime';
import { buildIcs, escapeIcsText } from '../lib/email/ics';
import { classifyBusy } from '../lib/booking/occupancy';
import { AvailabilityUnknownError, HostNotConnectedError } from '../lib/google/errors';
import { GOOGLE_AUTH_PARAMS, decryptRefreshToken, encryptRefreshToken, exchangeRefreshToken } from '../lib/google/oauth';
import { GOOGLE_CONSENT_SCOPES } from '../lib/auth/edge-config';
import { createMockCalendar } from '../lib/google/mock-calendar';
import type { BookingRow } from '../lib/booking/rows';
import type { CalendarListItem } from '../lib/google/calendar';
import { isoAt, MONDAY_0900 } from './support/harness';

// ---- AC-5 ----------------------------------------------------------------

describe('AC-5 — an address is one mailbox or it is rejected', () => {
  it('accepts a single addr-spec', () => {
    for (const value of ['ada@example.com', 'ada.lovelace+tag@sub.example.co.uk']) {
      assert.equal(isSingleMailbox(value), true, value);
      assert.equal(assertSingleMailbox(value), value.trim().toLowerCase());
    }
  });

  it('rejects every shape that could address a second recipient', () => {
    const attacks = [
      'a@b.com,c@d.com',
      'a@b.com;c@d.com',
      '"x"<a@b.com>',
      'Ada <ada@example.com>',
      'a@b.com\r\nBcc: x@y.z',
      'a@b.com\nTo: x@y.z',
      '',
      '   ',
      'no-at-sign',
      `${'a'.repeat(250)}@example.com`,
    ];
    for (const value of attacks) {
      assert.equal(isSingleMailbox(value), false, `must reject: ${JSON.stringify(value)}`);
      assert.throws(
        () => assertSingleMailbox(value),
        EmailAddressError,
        `must throw for: ${JSON.stringify(value)}`,
      );
    }
  });

  it('rejects header injection in free-text fields', () => {
    for (const value of ['Ada\r\nBcc: x@y.z', 'Ada\nSubject: hijacked', 'a\rb']) {
      assert.throws(() => assertNoHeaderInjection(value), EmailAddressError, value);
    }
    assert.equal(assertNoHeaderInjection('Ada Lovelace'), 'Ada Lovelace');
  });

  it('MIME-encodes headers so no raw CRLF or non-ASCII escapes', () => {
    const encoded = encodeHeaderValue('Café ☕ meeting');
    assert.equal(/[\r\n]/.test(encoded), false);
    assert.match(encoded, /^=\?UTF-8\?/, 'non-ASCII is RFC 2047 encoded');
    // Plain ASCII is left legible rather than needlessly encoded.
    assert.equal(encodeHeaderValue('Intro call'), 'Intro call');
  });

  it('builds a message whose headers cannot be injected into', () => {
    const mime = buildMimeMessage({
      to: 'ada@example.com',
      from: 'marlo@example.com',
      subject: 'Confirmed: Intro call ☕',
      body: 'Hello Ada,\nSee you then.\n',
      ics: { filename: 'invite.ics', content: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' },
    });

    const headerBlock = mime.slice(0, mime.indexOf('\r\n\r\n'));
    assert.equal(
      /\r\n(?:Bcc|Cc|To):/i.test(headerBlock.replace(/^To:.*$/m, '')),
      false,
      'exactly one To header, no injected Cc/Bcc',
    );
    assert.match(mime, /Content-Type: text\/calendar/i);
    // The raw form Gmail takes is base64url with no padding-unsafe characters.
    const raw = toGmailRaw(mime);
    assert.equal(/[+/=]/.test(raw), false, 'base64url, safe in a JSON body');
  });

  it('escapes ICS text per RFC 5545', () => {
    assert.equal(escapeIcsText('a;b,c\\d\ne'), 'a\\;b\\,c\\\\d\\ne');

    const ics = buildIcs({
      uid: 'bk_1@marlo',
      start: MONDAY_0900,
      end: isoAt(30),
      summary: 'Intro call; with Ada, and notes',
      description: 'line one\nline two',
      organizerEmail: 'demo@example.com',
      attendeeEmail: 'ada@example.com',
      status: 'CONFIRMED',
      sequence: 0,
      stamp: MONDAY_0900,
    });
    assert.match(ics, /SUMMARY:Intro call\\; with Ada\\, and notes/);
    assert.match(ics, /DESCRIPTION:line one\\nline two/);
    // Every ICS line ends CRLF and none contains a bare newline.
    for (const line of ics.split('\r\n')) {
      assert.equal(line.includes('\n'), false);
    }
  });
});

// ---- AC-7 ----------------------------------------------------------------

describe('AC-7 — Google reads are fail-closed, never "free"', () => {
  it('throws AvailabilityUnknown rather than returning an empty busy set', async () => {
    const calendar = createMockCalendar();
    calendar.failListWith({ status: 500 });

    await assert.rejects(
      () =>
        calendar.list({
          calendarId: 'primary',
          timeMin: MONDAY_0900,
          timeMax: isoAt(600),
        }),
      AvailabilityUnknownError,
      'a failed page must never read as "no busy times"',
    );
  });

  it('fails closed on a transport error too', async () => {
    const calendar = createMockCalendar();
    calendar.failListWith({ throw: new Error('socket hang up') });
    await assert.rejects(
      () =>
        calendar.list({ calendarId: 'primary', timeMin: MONDAY_0900, timeMax: isoAt(600) }),
      AvailabilityUnknownError,
    );
  });

  it('returns real items when the read succeeds', async () => {
    const calendar = createMockCalendar();
    calendar.seedExternal({ id: 'ext-1', start: MONDAY_0900, end: isoAt(30) });
    const items = await calendar.list({
      calendarId: 'primary',
      timeMin: MONDAY_0900,
      timeMax: isoAt(600),
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].id, 'ext-1');
  });
});

// ---- AC-8 / C7 -----------------------------------------------------------

describe('AC-8 / C7 — a managed item is excluded only when the store accounts for it', () => {
  const row = (patch: Partial<BookingRow> = {}): BookingRow => ({
    id: 'bk_1',
    token: 'tok_1',
    idempotencyKey: 'key',
    createFingerprint: 'fp',
    ownerId: 'own_demo',
    eventTypeId: 'evt',
    hostId: 'own_demo',
    start: MONDAY_0900,
    end: isoAt(30),
    status: 'confirmed',
    revision: 1,
    latestAction: 'confirm',
    googleEventId: 'marlolive',
    googleEventEtag: 'e1',
    calendarState: 'created',
    rescheduledFrom: null,
    reservedStart: null,
    reservedEnd: null,
    pendingOp: null,
    unfinishedCreate: null,
    unresolvedInserts: [],
    reapCursor: 0,
    inviteeName: 'Ada',
    inviteeEmail: 'ada@example.com',
    notes: null,
    metadata: {},
    createdAt: MONDAY_0900,
    ...patch,
  });

  const item = (patch: Partial<CalendarListItem> = {}): CalendarListItem => ({
    id: 'marlolive',
    status: 'confirmed',
    start: MONDAY_0900,
    end: isoAt(30),
    etag: 'e1',
    marloBookingId: 'bk_1',
    ...patch,
  });

  it('excludes a matched managed event (the store already counts it)', () => {
    const result = classifyBusy([item()], () => row());
    assert.deepEqual(result.busy, []);
    assert.deepEqual(result.reapCandidates, []);
  });

  it('counts a DISPLACED managed event as busy at its actual interval', () => {
    // The host dragged the event to 10:00 in Google Calendar. Its new interval
    // is busy, and the store's own occupancy still blocks the old one — a
    // host-moved event blocks both until the host fixes it (REV3-10).
    const moved = item({ start: isoAt(60), end: isoAt(90) });
    const result = classifyBusy([moved], () => row());
    assert.deepEqual(result.busy, [{ start: isoAt(60), end: isoAt(90) }]);
  });

  it('counts an UNMATCHED managed event (no row, or a cancelled one) as busy', () => {
    assert.deepEqual(classifyBusy([item()], () => null).busy, [
      { start: MONDAY_0900, end: isoAt(30) },
    ]);
    assert.deepEqual(
      classifyBusy([item()], () => row({ status: 'cancelled' })).busy,
      [{ start: MONDAY_0900, end: isoAt(30) }],
    );
  });

  it('treats a RETIRED id as busy AND reap-eligible, attributed by attemptId', () => {
    const late = item({ id: 'marloretired', marloAttemptId: 'attempt-a', etag: 'e9' });
    const cancelled = row({
      status: 'cancelled',
      googleEventId: 'marloretired',
      unresolvedInserts: [
        {
          attemptId: 'attempt-a',
          eventId: 'marloretired',
          opId: 'op-1',
          gen: 1,
          issuedAt: MONDAY_0900,
          inspectSeq: null,
          inspectedAt: null,
        },
      ],
    });

    const result = classifyBusy([late], () => cancelled);
    // Busy for THIS request whether or not the reap succeeds — a late landing
    // can never free-ride into a double booking (C6.3a).
    assert.deepEqual(result.busy, [{ start: MONDAY_0900, end: isoAt(30) }]);
    assert.deepEqual(result.reapCandidates, [
      {
        bookingId: 'bk_1',
        hostId: 'own_demo',
        eventId: 'marloretired',
        etag: 'e9',
        attemptId: 'attempt-a',
      },
    ]);
  });

  it('never reaps an item under a CONFIRMED row’s live id (REV5-02)', () => {
    // The first insert timed out and the retry applied: an entry names the live
    // id. It is matched, not reaped — that event *is* the booking's event.
    const live = row({
      unresolvedInserts: [
        {
          attemptId: 'attempt-1',
          eventId: 'marlolive',
          opId: 'op-1',
          gen: 1,
          issuedAt: MONDAY_0900,
          inspectSeq: null,
          inspectedAt: null,
        },
      ],
    });
    const result = classifyBusy([item()], () => live);
    assert.deepEqual(result.busy, []);
    assert.deepEqual(result.reapCandidates, [], 'a live id is never reap-eligible');
  });

  it('excludes the booking’s own event during its own reschedule', () => {
    const result = classifyBusy([item()], () => row(), { excludeBookingId: 'bk_1' });
    assert.deepEqual(result.busy, []);
  });

  it('never counts cancelled or transparent items as busy', () => {
    const cancelledItem = item({ id: 'ext-c', status: 'cancelled', marloBookingId: undefined });
    const transparent = item({
      id: 'ext-t',
      transparency: 'transparent',
      marloBookingId: undefined,
    });
    assert.deepEqual(classifyBusy([cancelledItem, transparent], () => null).busy, []);
  });

  it('counts an unmanaged external item as busy', () => {
    const external = item({ id: 'ext-1', marloBookingId: undefined });
    assert.deepEqual(classifyBusy([external], () => null).busy, [
      { start: MONDAY_0900, end: isoAt(30) },
    ]);
  });

  it('matches a RESERVED interval, so a paused reschedule is not double-counted', () => {
    const reserving = row({
      reservedStart: isoAt(60),
      reservedEnd: isoAt(90),
    });
    const atReservation = item({ start: isoAt(60), end: isoAt(90) });
    assert.deepEqual(classifyBusy([atReservation], () => reserving).busy, []);
  });
});

// ---- AC-14 ---------------------------------------------------------------

describe('AC-14 — one consent, the exact scope set, and encrypted refresh tokens', () => {
  it('requests exactly the C7 scope set with offline access', () => {
    assert.deepEqual([...GOOGLE_CONSENT_SCOPES], [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/calendar.freebusy',
      'https://www.googleapis.com/auth/calendar.events',
      'https://www.googleapis.com/auth/gmail.send',
    ]);
    assert.equal(GOOGLE_AUTH_PARAMS.access_type, 'offline');
    assert.equal(GOOGLE_AUTH_PARAMS.prompt, 'consent');
  });

  it('round-trips a refresh token through AES-256-GCM', () => {
    const key = 'a'.repeat(32);
    const encrypted = encryptRefreshToken('1//refresh-token-value', key);

    assert.equal(
      Buffer.from(encrypted).toString('utf8').includes('refresh-token-value'),
      false,
      'the plaintext must not survive in the ciphertext',
    );
    assert.equal(decryptRefreshToken(encrypted, key), '1//refresh-token-value');
  });

  it('refuses to decrypt under the wrong key, and refuses tampered ciphertext', () => {
    const encrypted = encryptRefreshToken('secret', 'a'.repeat(32));
    assert.throws(() => decryptRefreshToken(encrypted, 'b'.repeat(32)));

    const tampered = Uint8Array.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(
      () => decryptRefreshToken(tampered, 'a'.repeat(32)),
      'GCM must reject a modified tag',
    );
  });

  it('maps invalid_grant to host_not_connected rather than crashing', async () => {
    await assert.rejects(
      () =>
        exchangeRefreshToken({
          fetch: async () =>
            new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
          refreshToken: 'stale',
          clientId: 'id',
          clientSecret: 'secret',
        }),
      HostNotConnectedError,
    );
  });

  it('returns an access token on the happy path', async () => {
    const token = await exchangeRefreshToken({
      fetch: async () =>
        new Response(JSON.stringify({ access_token: 'ya29.token', expires_in: 3599 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      refreshToken: 'good',
      clientId: 'id',
      clientSecret: 'secret',
    });
    assert.equal(token.accessToken, 'ya29.token');
  });
});
