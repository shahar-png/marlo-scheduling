// C9 — the client half of create idempotency.
//
// The client owns the key **and the payload it was minted for**. The record is
// written to `sessionStorage` *before* the request is sent, so a lost response
// — a network error, a 5xx, a 503, or a reload mid-submit — leaves something to
// replay. Every replay sends the **stored** payload, never the current form
// state, because the form may have moved on.
//
// The whole subtlety is which responses may clear it:
//
//   terminal      the server proved no row exists for this key AND, for a
//                 conflict, durably fenced `(key, fingerprint)` so none can
//                 ever be inserted later (REV8-01). Safe to mint a new key.
//   non-terminal  the original create may still be alive somewhere. Clearing
//                 here is exactly how a guest ends up with two bookings.
//
// It also drops late responses for a key that is no longer the current record
// (`stale_response_ignored`): the fence's client-side half.

export type SubmissionPayload = {
  ownerSlug: string;
  eventSlug: string;
  start: string;
  invitee: { name: string; email: string };
  notes?: string;
};

export type SubmissionRecord = {
  key: string;
  payload: SubmissionPayload;
  startedAt: string;
};

/** The `sessionStorage` surface this module needs — injectable for tests. */
export type RecordStorage = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

export function submissionStorageKey(ownerSlug: string, eventSlug: string): string {
  return `marlo:submission:${ownerSlug}/${eventSlug}`;
}

/**
 * Terminal responses (C9). Each one proves the key is unusable *and* that no
 * in-flight attempt can still commit under it:
 *
 *   201  the booking exists — navigate;
 *   400  rejected before any store write;
 *   409  `slot_unavailable` / `session_full` — the locked lookup found no row
 *        and the same transaction wrote the `create_rejections` fence;
 *   422  `idempotency_key_reused` — a row exists but is not this submission's.
 */
export function isTerminalForKey(status: number, code: string | null): boolean {
  if (status === 201 || status === 400 || status === 422) {
    return true;
  }
  if (status === 409) {
    return code === 'slot_unavailable' || code === 'session_full';
  }
  return false;
}

/**
 * Non-terminal codes the client replays rather than surfacing as failure:
 * the original create is still active, or its outcome is unknown.
 */
export function isReplayable(status: number, code: string | null): boolean {
  if (status === 409) {
    return code === 'operation_in_progress' || code === 'operation_superseded';
  }
  return status === 503 || status >= 500;
}

/**
 * C9 / AC-19(f′) — the one response the client replays **automatically**, once,
 * after the server's own `retryAfterSeconds`: the original create is provably
 * still running somewhere, and the server said how long to wait. Everything else
 * non-terminal (503, 5xx, a network error) has no defined window and goes
 * straight to the explicit **Try again** / **Start over** state.
 */
export function isAutoReplayable(status: number, code: string | null): boolean {
  return status === 409 && code === 'operation_in_progress';
}

/** The default wait when the server sent no window (C3 always sends one). */
export const DEFAULT_RETRY_AFTER_SECONDS = 1;

export function readRecord(
  storage: RecordStorage | null,
  ownerSlug: string,
  eventSlug: string,
): SubmissionRecord | null {
  if (storage === null) {
    return null;
  }
  let raw: string | null;
  try {
    raw = storage.getItem(submissionStorageKey(ownerSlug, eventSlug));
  } catch {
    // Storage can throw (privacy modes, quota, disabled cookies). It is a
    // *cache* of the in-memory record, never the authority.
    return null;
  }
  if (raw === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as SubmissionRecord;
    if (
      typeof parsed?.key !== 'string' ||
      typeof parsed?.payload?.start !== 'string' ||
      typeof parsed?.payload?.invitee?.email !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    // A corrupt record is no record; it must never block the form.
    return null;
  }
}

/**
 * Best-effort persistence. Returns whether the record survives a reload; the
 * caller keeps it in memory either way, so a storage failure never costs the
 * current submission its key.
 */
export function writeRecord(
  storage: RecordStorage | null,
  record: SubmissionRecord,
): boolean {
  if (storage === null) {
    return false;
  }
  try {
    storage.setItem(
      submissionStorageKey(record.payload.ownerSlug, record.payload.eventSlug),
      JSON.stringify(record),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearRecord(
  storage: RecordStorage | null,
  ownerSlug: string,
  eventSlug: string,
): void {
  try {
    storage?.removeItem(submissionStorageKey(ownerSlug, eventSlug));
  } catch {
    // Nothing to do: the in-memory record is already cleared by the caller.
  }
}
