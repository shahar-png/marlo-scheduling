// C6.0 — the ONE classification of every Google response, shared by the live
// adapter, the mock adapter, the fake `fetch` model, and every C6 lifecycle
// step. No other module under `lib/booking/**` or `lib/google/**` compares a
// status code (asserted by the AC-25 import-graph test).
//
// **429 is `ambiguous`, never `definite`** (Product bar lock §2): a
// rate-limited request may still be applied by Google, and a definite
// classification would clear the attempt and its `pending_op` while the insert
// can still land — exactly the state C6.3a exists to prevent.

export const APPLIED = 'applied' as const;
export const DEFINITE = 'definite' as const;
export const ALREADY_EXISTS = 'already_exists' as const;
export const PRECONDITION_FAILED = 'precondition_failed' as const;
export const AMBIGUOUS = 'ambiguous' as const;

export type CalendarOutcomeClass =
  | typeof APPLIED
  | typeof DEFINITE
  | typeof ALREADY_EXISTS
  | typeof PRECONDITION_FAILED
  | typeof AMBIGUOUS;

/** Statuses that are decided by identity, not by range. */
const OK = new Set([200, 201, 202, 204]);
const CONFLICT = 409;
const PRECONDITION = 412;
const RATE_LIMITED = 429;
const NOT_FOUND = 404;
const GONE = 410;
const CLIENT_MIN = 400;
const CLIENT_MAX = 499;

export class HostNotConnectedError extends Error {
  readonly code = 'host_not_connected';
  constructor(message = 'host_not_connected') {
    super(message);
    this.name = 'HostNotConnectedError';
  }
}

export class CalendarError extends Error {
  constructor(
    readonly outcome: CalendarOutcomeClass,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'CalendarError';
  }
}

export class AvailabilityUnknownError extends Error {
  readonly code = 'availability_unknown';
  constructor(message = 'availability_unknown') {
    super(message);
    this.name = 'AvailabilityUnknownError';
  }
}

export class PreconditionFailedError extends CalendarError {
  constructor(message = 'precondition_failed') {
    super(PRECONDITION_FAILED, PRECONDITION, message);
    this.name = 'PreconditionFailedError';
  }
}

export class AlreadyExistsError extends CalendarError {
  constructor(message = 'duplicate') {
    super(ALREADY_EXISTS, CONFLICT, message);
    this.name = 'AlreadyExistsError';
  }
}

export type ClassifiableOutcome =
  | { status: number }
  | { status?: undefined; error: unknown }
  | number
  | unknown;

/**
 * Classifies a Google Calendar outcome. Accepts a status number, a
 * `{ status }` response, or a thrown error (timeout / socket / malformed
 * body), and is the only place a status code is interpreted.
 */
export function classifyCalendarError(outcome: ClassifiableOutcome): CalendarOutcomeClass {
  const status = statusOf(outcome);
  if (status !== null) {
    if (OK.has(status)) {
      return APPLIED;
    }
    if (status === CONFLICT) {
      return ALREADY_EXISTS;
    }
    if (status === PRECONDITION) {
      return PRECONDITION_FAILED;
    }
    if (status === RATE_LIMITED) {
      // Never definite: Google may still apply a rate-limited request.
      return AMBIGUOUS;
    }
    if (status >= CLIENT_MIN && status <= CLIENT_MAX) {
      return DEFINITE;
    }
    // 5xx and anything else unrecognised: the request may have executed.
    return AMBIGUOUS;
  }

  if (outcome instanceof HostNotConnectedError) {
    // The token exchange provably refused: the request never went out.
    return DEFINITE;
  }
  if (outcome instanceof CalendarError) {
    return outcome.outcome;
  }
  // Timeout, network error, malformed response, process death.
  return AMBIGUOUS;
}

/**
 * 404/410 — the resource is not there.
 *
 * This is a *different question* from the C6.0 classification and the two must
 * not be confused: on `insert` and `patch` a 404/410 is a **definite** rejection
 * (the mutation provably did nothing), while on `get` and `remove` it is a
 * tolerated **absence** — `get` returns `null` and `remove` answers `absent`
 * (C6.7's "404/410 tolerated"). It lives here so the adapters share one notion
 * of "not there" and no module outside this file reads a status number.
 */
export function isAbsenceStatus(outcome: ClassifiableOutcome): boolean {
  const status = statusOf(outcome);
  return status === NOT_FOUND || status === GONE;
}

/** Gmail uses the same rule for the C5 finalisation (429 stays ambiguous). */
export function classifyGmailError(outcome: ClassifiableOutcome): CalendarOutcomeClass {
  return classifyCalendarError(outcome);
}

/**
 * C5 finalisation rule: only a **definite** Gmail refusal writes `failed`.
 * Anything ambiguous leaves the row `claimed`, because Gmail may have
 * accepted the message.
 */
export function isDefiniteRefusal(outcome: ClassifiableOutcome): boolean {
  const klass = classifyGmailError(outcome);
  return klass === DEFINITE;
}

export function isApplied(outcome: ClassifiableOutcome): boolean {
  return classifyCalendarError(outcome) === APPLIED;
}

export function isAmbiguous(outcome: ClassifiableOutcome): boolean {
  return classifyCalendarError(outcome) === AMBIGUOUS;
}

function statusOf(outcome: ClassifiableOutcome): number | null {
  if (typeof outcome === 'number' && Number.isFinite(outcome)) {
    return outcome;
  }
  if (typeof outcome === 'object' && outcome !== null && 'status' in outcome) {
    const status = (outcome as { status?: unknown }).status;
    if (typeof status === 'number' && Number.isFinite(status)) {
      return status;
    }
  }
  return null;
}
