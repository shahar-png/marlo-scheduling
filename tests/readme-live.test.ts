// AC-16 — README doc-presence contract for LIVE-INT.
//
// The README is part of the contract, not decoration: three of its sentences
// were *negotiated down* from claims earlier revisions made and could not keep
// (REV5-03 transient overlap, REV5-05/REV6-05 email ordering, REV6-04/REV7-04
// the duplicate bound). This test asserts both halves — that the honest
// wording is present, and that the withdrawn wording has not crept back.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const readme = readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

const ENV_NAMES = [
  'DATABASE_URL',
  'LIVE_CALENDAR',
  'LIVE_EMAIL',
  'OAUTH_TOKEN_KEY',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'MARLO_PROOF',
  'MARLO_OFFLINE',
];

const ROUTES = [
  '/{ownerSlug}/{eventSlug}',
  '/api/owners/{ownerSlug}/event-types/{eventSlug}/available-times',
  '/api/owners/{ownerSlug}/event-types/{eventSlug}/bookings',
  '/api/bookings/{id}/available-times',
  '/api/bookings/{id}/notify',
  '/api/links/{token}/bookings',
  '/api/health',
  '/b/{token}',
];

// Each entry is a contract clause AC-16 names, with the phrase that carries it.
const REQUIRED_PHRASES: Array<[string, string]> = [
  ['migration procedure (C8)', 'db:migrate'],
  ['store guard', 'store_not_migrated'],
  ['create idempotency (C9)', 'Idempotency-Key'],
  ['bearer transport (C11)', 'Authorization: Bearer'],
  ['id/token split (C11)', 'token_required'],
  ['one-off links are fixture-only (C10)', 'links_not_supported'],
  ['consumed-link replay (REV3-09)', 'consumed'],
  ['group/collective scope-out (C6.9)', 'group_not_supported'],
  ['reserved owner slugs (REV5-06)', 'owner_slug_reserved'],
  ['reschedule grid (REV3-08)', '15-minute'],
  ['calendar_state values (C6.8)', 'calendar_state'],
  ['repair on notify (C6.8)', 'calendar repair'],
  ['notify retry-latest form (C5)', 'retry-latest'],
  ['operation_in_progress waits (C12)', 'operation_in_progress'],
  ['booking_outcome_unknown reloads (C12)', 'booking_outcome_unknown'],
  ['cancelled-panel retry control (REV3-07)', 'Retry notification'],
  ['reload recovery (REV3-06)', 'Finishing your booking'],
  ['external check before save (REV6-03)', 'before the booking is saved'],
  ['offline contract (AC-6)', 'offline once `node_modules` is present'],
  ['offline contract (AC-6)', 'unless `MARLO_OFFLINE=1`'],
  ['health 503 rule (C13)', '503'],
  ['delivery.email over the required set (REV4-05)', 'required recipient set'],
];

// The narrowed guarantees, quoted as the PLAN fixes them.
const NARROWED_GUARANTEES: Array<[string, string]> = [
  ['email ordering (REV5-05)', 'can occasionally arrive after a later one'],
  ['arrival order establishes nothing (REV6-05)', "does not tell you the booking's current state"],
  ['booking page is authoritative (REV6-05)', 'authoritative status'],
  ['duplicate bound (REV6-04)', 'more than one copy'],
  ['copies ≤ retries (REV6-04)', 'never exceeds the number of retries'],
  ['failed sends retry immediately (REV7-04)', 'retried immediately'],
  ['claimed sends wait a window (REV7-04)', 'stale window'],
  ['late landing never offered (REV5-03)', 'never offered as free time'],
  ['late landing never persists (REV5-03)', 'never persists'],
  ['transient overlap is accepted (REV5-03)', 'transient'],
];

describe('AC-16 README documents the LIVE-INT contract', () => {
  it('names every environment variable', () => {
    for (const name of ENV_NAMES) {
      assert.match(readme, new RegExp(`\\b${name}\\b`), `README must name ${name}`);
    }
  });

  it('names every public route shape', () => {
    for (const route of ROUTES) {
      assert.ok(readme.includes(route), `README must document ${route}`);
    }
  });

  it('carries every required contract clause', () => {
    for (const [clause, phrase] of REQUIRED_PHRASES) {
      assert.ok(readme.includes(phrase), `README must state ${clause} ("${phrase}")`);
    }
  });

  it('states the narrowed guarantees in their honest form', () => {
    for (const [clause, phrase] of NARROWED_GUARANTEES) {
      assert.ok(readme.includes(phrase), `README must state ${clause} ("${phrase}")`);
    }
  });
});

describe('AC-16 README does not restate withdrawn claims', () => {
  // REV6-05: withdrawn, because in the AC-13(c) interleaving the most recently
  // received email describes a confirmed booking that is cancelled.
  it('never claims the most recent email describes the current state', () => {
    assert.equal(
      /most recent email describes/i.test(readme),
      false,
      'REV6-05 withdrew "the most recent email describes the booking\'s current state"',
    );
  });

  // REV7-04: the window governs takeover of an *unresolved* send only. A
  // definitely-refused send is re-claimable immediately, so the unqualified
  // sentence was false. Every occurrence must carry the qualifier.
  it('never states the stale-window bound without the unresolved-send qualifier', () => {
    const pattern = /at most once per 2-minute stale window/g;
    const occurrences = [...readme.matchAll(pattern)];
    assert.ok(occurrences.length > 0, 'README must state the claim bound at all');
    for (const match of occurrences) {
      const sentence = sentenceAround(readme, match.index ?? 0);
      assert.match(
        sentence,
        /still unresolved/,
        `unqualified stale-window claim (REV7-04) in: "${sentence.trim()}"`,
      );
    }
  });

  it('does not promise exactly-once email or a prevented overlap', () => {
    assert.equal(/exactly.once/i.test(readme), false);
    assert.equal(/never overlap/i.test(readme), false);
  });
});

/** The sentence containing `index`, bounded by `.`, `;`, or a newline. */
function sentenceAround(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf('.', index),
    text.lastIndexOf(';', index),
    text.lastIndexOf('\n', index),
  );
  const candidates = [
    text.indexOf('.', index),
    text.indexOf(';', index),
    text.indexOf('\n', index),
  ].filter((position) => position !== -1);
  const end = candidates.length === 0 ? text.length : Math.min(...candidates);
  return text.slice(start + 1, end);
}
