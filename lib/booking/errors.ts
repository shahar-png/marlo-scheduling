// Every error code in the C3 envelope, as one typed vocabulary. Routes map
// these to a status + body through `lifecycleResponse()`, so a code can never
// be spelled two ways.
//
// The distinction the client depends on (C9): **terminal** responses let it
// clear its unresolved-submission record; **non-terminal** ones must not.

export type ErrorCode =
  | 'slot_unavailable'
  | 'session_full'
  | 'booking_changed'
  | 'operation_in_progress'
  | 'operation_superseded'
  | 'stale_revision'
  | 'idempotency_key_required'
  | 'idempotency_key_reused'
  | 'notify_request_invalid'
  | 'availability_unknown'
  | 'booking_outcome_unknown'
  | 'calendar_patch_failed'
  | 'calendar_delete_failed'
  | 'reschedule_failed'
  | 'repair_failed'
  | 'booking_failed'
  | 'token_required'
  | 'booking_not_found'
  | 'owner_not_found'
  | 'owner_required'
  | 'event_type_not_found'
  | 'links_not_supported'
  | 'group_not_supported'
  | 'collective_not_supported'
  | 'store_not_migrated';

export class LifecycleError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    /** Extra members merged into the JSON body. */
    readonly body: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'LifecycleError';
  }
}

export class SlotUnavailableError extends LifecycleError {
  constructor() {
    super('slot_unavailable', 409);
  }
}

export class SessionFullError extends LifecycleError {
  constructor() {
    super('session_full', 409);
  }
}

export class BookingChangedError extends LifecycleError {
  constructor(booking?: unknown) {
    super('booking_changed', 409, booking === undefined ? {} : { booking });
  }
}

export class OperationInProgressError extends LifecycleError {
  constructor(retryAfterSeconds: number, booking?: unknown) {
    super('operation_in_progress', 409, {
      retryAfterSeconds,
      ...(booking === undefined ? {} : { booking }),
    });
  }
}

export class OperationSupersededError extends LifecycleError {
  constructor(booking?: unknown) {
    super('operation_superseded', 409, booking === undefined ? {} : { booking });
  }
}

export class StaleRevisionError extends LifecycleError {
  constructor(revision: number, latestAction: string | null) {
    super('stale_revision', 409, { revision, latestAction });
  }
}

export class IdempotencyKeyRequiredError extends LifecycleError {
  constructor() {
    super('idempotency_key_required', 400);
  }
}

export class IdempotencyKeyReusedError extends LifecycleError {
  constructor() {
    super('idempotency_key_reused', 422);
  }
}

export class NotifyRequestInvalidError extends LifecycleError {
  constructor() {
    super('notify_request_invalid', 400);
  }
}

export class AvailabilityUnknownResponse extends LifecycleError {
  constructor() {
    super('availability_unknown', 503);
  }
}

export class BookingOutcomeUnknownError extends LifecycleError {
  constructor(retryAfterSeconds = 5) {
    super('booking_outcome_unknown', 503, { retryAfterSeconds });
  }
}

export class CalendarPatchFailedError extends LifecycleError {
  constructor() {
    super('calendar_patch_failed', 502);
  }
}

export class CalendarDeleteFailedError extends LifecycleError {
  constructor() {
    super('calendar_delete_failed', 502);
  }
}

export class RescheduleFailedError extends LifecycleError {
  constructor() {
    super('reschedule_failed', 500);
  }
}

export class RepairFailedError extends LifecycleError {
  constructor() {
    super('repair_failed', 500);
  }
}

export class BookingFailedError extends LifecycleError {
  constructor() {
    super('booking_failed', 500);
  }
}

export class TokenRequiredError extends LifecycleError {
  constructor() {
    super('token_required', 401);
  }
}

export class BookingNotFoundResponse extends LifecycleError {
  constructor() {
    super('booking_not_found', 404);
  }
}

export class OwnerNotFoundError extends LifecycleError {
  constructor() {
    super('owner_not_found', 404);
  }
}

export class OwnerRequiredError extends LifecycleError {
  constructor() {
    super('owner_required', 404);
  }
}

export class EventTypeNotFoundError extends LifecycleError {
  constructor() {
    super('event_type_not_found', 404);
  }
}

export class LinksNotSupportedError extends LifecycleError {
  constructor() {
    super('links_not_supported', 501);
  }
}

export class GroupNotSupportedError extends LifecycleError {
  constructor() {
    super('group_not_supported', 501);
  }
}

export class CollectiveNotSupportedError extends LifecycleError {
  constructor() {
    super('collective_not_supported', 501);
  }
}

/**
 * Terminal for the client's idempotency key (C9): the key is provably unusable
 * and a new one must be minted. Everything else is non-terminal — the record
 * is retained and replayed.
 */
const TERMINAL_CODES = new Set<ErrorCode>([
  'slot_unavailable',
  'session_full',
  'idempotency_key_required',
  'idempotency_key_reused',
]);

export function isTerminalForKey(code: ErrorCode): boolean {
  return TERMINAL_CODES.has(code);
}

export type LifecycleResponseBody = { error: ErrorCode } & Record<string, unknown>;

export function lifecycleResponse(error: unknown): {
  status: number;
  body: LifecycleResponseBody;
} | null {
  if (error instanceof LifecycleError) {
    return {
      status: error.status,
      body: { error: error.code, ...error.body },
    };
  }
  return null;
}
