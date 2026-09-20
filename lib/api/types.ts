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
  invitee: { name: string; email: string };
};

export const SLOT_UNAVAILABLE = 'slot_unavailable' as const;
export const SESSION_FULL = 'session_full' as const;
export const UNKNOWN_ERROR = 'unknown' as const;

export type BookingConflictCode =
  | typeof SLOT_UNAVAILABLE
  | typeof SESSION_FULL;

export type CreateBookingResult =
  | { ok: true; booking: PublicBooking }
  | { ok: false; code: BookingConflictCode }
  | { ok: false; code: typeof UNKNOWN_ERROR; status: number; error?: string };

export type GetSlotsInput = {
  slug: string;
  timeMin: string;
  timeMax: string;
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
