// C9 / REV3-05 — the immutable create fingerprint.
//
// Written once in create T1 and **never recomputed or updated**, so a replay of
// an old key is compared against what the submission was minted for, not
// against the mutable `bookings.start` a reschedule has since moved.

import { createHash } from 'node:crypto';

export type CreateFingerprintInput = {
  eventTypeId: string;
  /** The ORIGINAL requested start, ISO-8601 UTC with milliseconds. */
  start: string;
  inviteeEmail: string;
};

export function createFingerprint(input: CreateFingerprintInput): string {
  const canonical = JSON.stringify({
    eventTypeId: input.eventTypeId,
    start: new Date(Date.parse(input.start)).toISOString(),
    inviteeEmail: input.inviteeEmail.trim().toLowerCase(),
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
