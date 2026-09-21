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

export type PublicBooking = {
  token: string;
  start: string;
  end: string;
  status: string;
  eventTypeId: string;
  invitee: { name: string; email: string };
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
  | { ok: false; code: typeof UNKNOWN_ERROR; status?: number; error?: string };

export type GetSlotsInput = {
  slug: string;
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
