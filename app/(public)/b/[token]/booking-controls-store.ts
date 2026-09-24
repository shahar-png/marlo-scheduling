// C12 — the `/b/{token}` control machine.
//
// P2 is a locked product decision: the guest's change path is this page, not
// "reopen the event link and book again". That makes the state machine part of
// the contract rather than presentation, so it lives here as plain TypeScript
// with every dependency injected, and the tests drive these handlers against
// the **real** route handlers (AC-21) rather than a mocked client.
//
// The states, and why each exists:
//
//   idle      nothing in flight.
//   pending   a request is in flight, or the server answered 409
//             `operation_in_progress`. One automatic retry follows.
//   stalled   that automatic retry was *also* answered `operation_in_progress`
//             — another caller took the stale op over and renewed its window.
//             Nothing is in flight and no retry is left, so the page offers
//             **Try again** and **Reload** explicitly. Without this state the
//             page sits disabled forever with nothing happening (REV8-03).
//   conflict  the booking changed, or the slot went away.
//   error     a transport or calendar failure. A 503 `booking_outcome_unknown`
//             offers a **reload**, never a re-submit: we do not know whether the
//             first attempt took effect.
//   done      the operation succeeded; the page re-renders from the response.

import type { LifecycleResult, PublicBooking, Slot } from '@/lib/api/types';

export type ControlsState = 'idle' | 'pending' | 'stalled' | 'conflict' | 'error' | 'done';

/** The request a `stalled` Try again re-sends — identical, never re-derived. */
export type PendingRequest =
  | { kind: 'reschedule'; start: string; expectedRevision: number }
  | { kind: 'cancel'; expectedRevision: number }
  | { kind: 'notify'; action?: string; expectedRevision?: number };

export type ConflictKind = 'slot' | 'changed' | null;

export type ControlsSnapshot = {
  booking: PublicBooking;
  state: ControlsState;
  /** Two-step cancel: the button arms an inline confirm (C12). */
  cancelArmed: boolean;
  pickerOpen: boolean;
  times: Slot[];
  loadingTimes: boolean;
  conflict: ConflictKind;
  /** Set only by 503 `booking_outcome_unknown`: reload, never re-submit. */
  outcomeUnknown: boolean;
  errorCode: string | null;
  stalledRequest: PendingRequest | null;
  retryAfterSeconds: number | null;
  /**
   * The `(revision, action)` pair this page *observed itself* completing. It is
   * `null` on a fresh load — which is precisely when C5's retry-latest form
   * exists — and is never inferred from the booking's shape, because a page
   * that guesses the pair can only guess it wrong.
   */
  lastAction: { action: string; revision: number } | null;
};

export type ControlsApi = {
  getBookingById(input: { id: string; token: string }): Promise<PublicBooking | null>;
  getBookingAvailability(input: {
    id: string;
    token: string;
    timeMin: string;
    timeMax: string;
  }): Promise<{ times: Slot[] }>;
  rescheduleBooking(input: {
    id: string;
    token: string;
    start: string;
    expectedRevision: number;
  }): Promise<LifecycleResult>;
  cancelBooking(input: {
    id: string;
    token: string;
    expectedRevision: number;
  }): Promise<LifecycleResult>;
  retryNotification(input: {
    id: string;
    token: string;
    action?: string;
    expectedRevision?: number;
  }): Promise<LifecycleResult>;
};

export type ControlsDeps = {
  booking: PublicBooking;
  api: ControlsApi;
  now: () => Date;
  /** Injected so the automatic retry never depends on wall-clock progress. */
  wait: (ms: number) => Promise<void>;
  /** How far ahead the reschedule picker asks for slots. */
  windowDays?: number;
};

const DEFAULT_WINDOW_DAYS = 14;

export class BookingControlsStore {
  private snapshot: ControlsSnapshot;
  private readonly listeners = new Set<() => void>();
  /** Synchronous in-flight latch: a second click in the same tick is a no-op. */
  private latch = false;

  constructor(private readonly deps: ControlsDeps) {
    this.snapshot = {
      booking: deps.booking,
      state: 'idle',
      cancelArmed: false,
      pickerOpen: false,
      times: [],
      loadingTimes: false,
      conflict: null,
      outcomeUnknown: false,
      errorCode: null,
      stalledRequest: null,
      retryAfterSeconds: null,
      lastAction: null,
    };
  }

  getState = (): ControlsSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /**
   * Whether the ordinary controls are interactive. `stalled` disables them
   * deliberately: the guest has exactly one way forward (Try again or Reload),
   * so they cannot start a second operation on top of the stuck one.
   */
  controlsEnabled(): boolean {
    return this.snapshot.state !== 'pending' && this.snapshot.state !== 'stalled';
  }

  private get credentials(): { id: string; token: string } {
    return { id: this.snapshot.booking.id, token: this.snapshot.booking.token };
  }

  // ---- reschedule ---------------------------------------------------------

  openPicker = async (): Promise<void> => {
    if (!this.controlsEnabled()) {
      return;
    }
    this.patch({ pickerOpen: true, loadingTimes: true, conflict: null });
    await this.loadTimes();
  };

  closePicker = (): void => {
    this.patch({ pickerOpen: false, times: [] });
  };

  private async loadTimes(): Promise<void> {
    const from = this.deps.now();
    const days = this.deps.windowDays ?? DEFAULT_WINDOW_DAYS;
    try {
      const result = await this.deps.api.getBookingAvailability({
        ...this.credentials,
        timeMin: from.toISOString(),
        timeMax: new Date(from.getTime() + days * 86_400_000).toISOString(),
      });
      this.patch({ times: result.times, loadingTimes: false });
    } catch {
      this.patch({ times: [], loadingTimes: false, state: 'error', errorCode: 'generic' });
    }
  }

  selectSlot = async (start: string): Promise<void> => {
    await this.run({
      kind: 'reschedule',
      start,
      expectedRevision: this.snapshot.booking.revision ?? 0,
    });
  };

  // ---- cancel -------------------------------------------------------------

  armCancel = (): void => {
    if (this.controlsEnabled()) {
      this.patch({ cancelArmed: true });
    }
  };

  disarmCancel = (): void => {
    this.patch({ cancelArmed: false });
  };

  confirmCancel = async (): Promise<void> => {
    await this.run({
      kind: 'cancel',
      expectedRevision: this.snapshot.booking.revision ?? 0,
    });
  };

  // ---- resend / retry notification ---------------------------------------

  /**
   * C5's two forms. After an in-page action the store holds a revision and
   * sends the revision-specific form; after a reload it has none in hand and
   * sends `{}`, the explicit retry-latest form.
   */
  resend = async (): Promise<void> => {
    const held = this.snapshot.lastAction;
    await this.run(
      held === null
        ? { kind: 'notify' }
        : { kind: 'notify', action: held.action, expectedRevision: held.revision },
    );
  };

  // ---- the machine --------------------------------------------------------

  /** `stalled` → Try again: the identical request, with its original revision. */
  tryAgain = async (): Promise<void> => {
    const request = this.snapshot.stalledRequest;
    if (request === null) {
      return;
    }
    this.patch({ state: 'idle', stalledRequest: null });
    await this.run(request);
  };

  /** `stalled` → Reload: re-read the booking and return to `idle`. */
  reload = async (): Promise<void> => {
    this.patch({ state: 'pending' });
    try {
      const fresh = await this.deps.api.getBookingById(this.credentials);
      if (fresh === null) {
        this.patch({ state: 'error', errorCode: 'booking_not_found' });
        return;
      }
      this.patch({
        booking: fresh,
        state: 'idle',
        stalledRequest: null,
        conflict: null,
        outcomeUnknown: false,
        errorCode: null,
        retryAfterSeconds: null,
        cancelArmed: false,
        pickerOpen: false,
        // A reload re-reads the row; it does not observe an action completing,
        // so the page goes back to having no pair in hand (C5 retry-latest).
        lastAction: null,
      });
    } catch {
      this.patch({ state: 'error', errorCode: 'generic' });
    }
  };

  private async run(request: PendingRequest, automatic = false): Promise<void> {
    if (this.latch) {
      return;
    }
    this.latch = true;
    this.patch({ state: 'pending', conflict: null, errorCode: null, outcomeUnknown: false });

    let result: LifecycleResult;
    try {
      result = await this.send(request);
    } catch {
      this.latch = false;
      this.patch({ state: 'error', errorCode: 'generic', stalledRequest: request });
      return;
    }
    this.latch = false;

    if (result.ok) {
      this.patch({
        booking: result.booking,
        state: 'done',
        cancelArmed: false,
        pickerOpen: false,
        times: [],
        stalledRequest: null,
        retryAfterSeconds: null,
        // Only a lifecycle change establishes a new pair; a notify retry does
        // not, so it leaves whatever the page already held alone.
        ...(request.kind === 'notify'
          ? {}
          : {
              lastAction: {
                action: request.kind === 'cancel' ? 'cancel' : 'reschedule',
                revision: result.booking.revision ?? 0,
              },
            }),
      });
      return;
    }

    if (result.code === 'operation_in_progress') {
      if (automatic) {
        // The single automatic retry was also refused: another caller took the
        // stale op over and renewed its window. Stop retrying and hand the
        // guest two explicit ways forward (REV8-03).
        this.patch({
          state: 'stalled',
          stalledRequest: request,
          retryAfterSeconds: result.retryAfterSeconds ?? null,
        });
        return;
      }
      this.patch({ retryAfterSeconds: result.retryAfterSeconds ?? null });
      await this.deps.wait((result.retryAfterSeconds ?? 1) * 1000);
      await this.run(request, true);
      return;
    }

    if (result.code === 'slot_unavailable' || result.code === 'session_full') {
      this.patch({ state: 'conflict', conflict: 'slot', stalledRequest: null });
      if (this.snapshot.pickerOpen) {
        await this.loadTimes();
      }
      return;
    }

    if (
      result.code === 'booking_changed' ||
      result.code === 'operation_superseded' ||
      result.code === 'stale_revision'
    ) {
      // The booking changed elsewhere: show the latest rather than silently
      // substituting a newer revision into a request the guest did not confirm.
      let fresh = result.booking ?? null;
      if (fresh === null) {
        try {
          fresh = await this.deps.api.getBookingById(this.credentials);
        } catch {
          // A `stale_revision` body carries no booking, so this refresh is the
          // only way to show the latest — and it can fail (503, network). The
          // page must not stay in `pending` with nothing in flight: re-sending
          // a request the guest did not re-confirm is wrong here, so the exit
          // is the reload-only recoverable error (C12, REVIEW-08).
          this.patch({
            state: 'error',
            errorCode: result.code,
            outcomeUnknown: true,
            stalledRequest: null,
            cancelArmed: false,
          });
          return;
        }
      }
      this.patch({
        ...(fresh === null ? {} : { booking: fresh }),
        state: 'conflict',
        conflict: 'changed',
        stalledRequest: null,
        cancelArmed: false,
      });
      return;
    }

    if (result.code === 'booking_outcome_unknown') {
      // We do not know whether it took effect, so the only offered action is a
      // reload — never a re-submit.
      this.patch({
        state: 'error',
        errorCode: result.code,
        outcomeUnknown: true,
        stalledRequest: null,
      });
      return;
    }

    this.patch({ state: 'error', errorCode: result.code, stalledRequest: request });
  }

  private send(request: PendingRequest): Promise<LifecycleResult> {
    if (request.kind === 'reschedule') {
      return this.deps.api.rescheduleBooking({
        ...this.credentials,
        start: request.start,
        expectedRevision: request.expectedRevision,
      });
    }
    if (request.kind === 'cancel') {
      return this.deps.api.cancelBooking({
        ...this.credentials,
        expectedRevision: request.expectedRevision,
      });
    }
    return this.deps.api.retryNotification({
      ...this.credentials,
      ...(request.action === undefined ? {} : { action: request.action }),
      ...(request.expectedRevision === undefined
        ? {}
        : { expectedRevision: request.expectedRevision }),
    });
  }

  private patch(patch: Partial<ControlsSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/**
 * C12 / REV3-07 — the cancelled panel offers a retry **iff** delivery is not
 * `sent`. There is no background worker, so this control is the only retry path
 * and must exist both right after cancelling and on a fresh load.
 */
export function needsDeliveryRetry(booking: PublicBooking): boolean {
  const email = booking.delivery?.email;
  return email === 'pending' || email === 'failed';
}

/** REV13-02 — `pending` renders as a status line, never as a control. */
export function calendarStatusLine(booking: PublicBooking): string | null {
  return booking.delivery?.calendar === 'pending'
    ? 'Calendar invite is still being created.'
    : null;
}

export function createBookingControlsStore(deps: ControlsDeps): BookingControlsStore {
  return new BookingControlsStore(deps);
}
