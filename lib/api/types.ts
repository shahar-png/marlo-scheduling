// UI-facing types for the public booking front-end (handoff §7 spirit, thin
// mapped shape). Only lib/api knows the repo's JSON; see DIVERGENCES.md.

export type Clock = () => Date;

export type Slot = {
  start: string;
  spotsRemaining?: number;
};

export type SlotsResult = {
  times: Slot[];
};

// C3 / C11: `id` and `token` are two different things. The id is the API path
// segment; the token is the `/b/{token}` capability and the bearer credential.
export type DeliveryEmailState = 'sent' | 'failed' | 'pending';
export type DeliveryCalendarState =
  | 'created'
  | 'failed'
  | 'skipped'
  | 'deleted'
  // REV13-02: `pending` mirrors `calendar_state='pending'` and is returned only
  // by the read surfaces; it renders as a status line with no control.
  | 'pending';

export type BookingDelivery = {
  email: DeliveryEmailState;
  calendar: DeliveryCalendarState;
  errors?: { email?: string; calendar?: string };
};

export type PublicBooking = {
  /** The API path segment. Absent on legacy fixture rows, where id === token. */
  id: string;
  token: string;
  start: string;
  end: string;
  status: string;
  eventTypeId: string;
  invitee: { name: string; email: string };
  ownerSlug?: string;
  eventSlug?: string;
  revision?: number;
  hostFirstName?: string;
  delivery?: BookingDelivery;
};

// Confirmation adapter result (BOOK-FE-15/17/19/20): a discriminated union.
//   - `booking`: the row's `hostId` resolved to a canonical host, so
//     `hostFirstName` is that host's (only ever set from a non-null HostMeta —
//     no default, no demo-name fallback). `bookAgainHref` is present iff the
//     canonical host, a store-backed event type, AND a representable public
//     path (public-path.ts) all resolved — independent of `status`.
//   - `unsupported_host`: the row exists but its host has no canonical
//     metadata; carries nothing the page could attribute.
//   - `null`: no row (other serverless isolate).
export type ConfirmedPublicBooking = PublicBooking & {
  kind: 'booking';
  hostFirstName: string;
  bookAgainHref?: string;
};

export type UnsupportedHostBooking = { kind: 'unsupported_host' };

export type PublicBookingResult =
  | ConfirmedPublicBooking
  | UnsupportedHostBooking
  | null;

export const SLOT_UNAVAILABLE = 'slot_unavailable' as const;
export const SESSION_FULL = 'session_full' as const;
export const UNKNOWN_ERROR = 'unknown' as const;

export type BookingConflictCode =
  | typeof SLOT_UNAVAILABLE
  | typeof SESSION_FULL;

export type CreateBookingResult =
  | { ok: true; booking: PublicBooking }
  | { ok: false; code: BookingConflictCode }
  | {
      ok: false;
      code: typeof UNKNOWN_ERROR;
      status?: number;
      error?: string;
      /**
       * C9 — the server's own wait for a non-terminal 409
       * `operation_in_progress`. Dropping it left the form with no window to
       * honour and no way to perform the single automatic replay C9 requires
       * (LIVE-REVIEW-11).
       */
      retryAfterSeconds?: number;
    };

export type GetSlotsInput = {
  slug: string;
  /**
   * C1 — the owner whose availability this is. Present on the product page, so
   * two owners offering `intro-30` each see their own calendar; absent only on
   * the retained legacy fixture surface, which resolves within `demo`.
   */
  ownerSlug?: string;
  // `[timeMin, timeMax)` is a window of **start** instants (BOOK-FE-12).
  timeMin: string;
  timeMax: string;
  // Event duration; the adapter widens the backend's end-bounded `timeMax`
  // by it and filters the returned starts back to `start < timeMax`.
  durationMinutes: number;
  now?: Clock;
};

export type CreateBookingInput = {
  slug: string;
  start: string;
  invitee: { name: string; email: string };
  now?: Clock;
  /** C1: present for the owner-scoped route; absent for the legacy one. */
  ownerSlug?: string;
  /** C9: the client owns the key and the payload it was minted for. */
  idempotencyKey?: string;
  notes?: string;
};

/** C9 non-terminal create codes — the client retains its record and replays. */
export const OPERATION_IN_PROGRESS = 'operation_in_progress' as const;
export const OPERATION_SUPERSEDED = 'operation_superseded' as const;
export const BOOKING_OUTCOME_UNKNOWN = 'booking_outcome_unknown' as const;
export const IDEMPOTENCY_KEY_REUSED = 'idempotency_key_reused' as const;
export const GROUP_NOT_SUPPORTED = 'group_not_supported' as const;
export const COLLECTIVE_NOT_SUPPORTED = 'collective_not_supported' as const;
export const BOOKING_CHANGED = 'booking_changed' as const;
export const STALE_REVISION = 'stale_revision' as const;

/** C11 — every `/api/bookings/{id}/*` call needs both, and they are not equal. */
export type BookingCredentials = { id: string; token: string };

/**
 * The result shape the `/b/{token}` control machine branches on (C12). A
 * lifecycle call never throws for a contract error: the code is the state.
 */
export type LifecycleResult =
  | { ok: true; booking: PublicBooking }
  | {
      ok: false;
      status: number;
      code: string;
      retryAfterSeconds?: number;
      /** Present when the server reported the current row alongside the error. */
      booking?: PublicBooking;
    };

export type BookingApi = {
  getSlots(input: GetSlotsInput): Promise<SlotsResult>;
  createBooking(input: CreateBookingInput): Promise<CreateBookingResult>;
};

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
