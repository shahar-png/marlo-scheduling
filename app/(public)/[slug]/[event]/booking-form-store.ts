import {
  SESSION_FULL,
  SLOT_UNAVAILABLE,
  type BookingApi,
  type BookingConflictCode,
  type Clock,
  type Slot,
} from '@/lib/api/types';
import { dateKey, monthOf, monthWindow, shiftMonth } from './month';

// State + the real event handlers behind <BookingForm>. Plain TypeScript so
// tests drive the form's own handlers (selectSlot / submit / tick) without a
// browser, then render the component for markup assertions. Every dependency
// (api, navigate, clock, interval scheduler, time zone) is injected — nothing
// here reaches for globals (neither the machine zone nor the wall clock).

export type Scheduler = {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type BookingFormDeps = {
  slug: string;
  // Event duration (minutes) — the lib/api adapter widens the backend end
  // bound by it (BOOK-FE-12); the form itself only sends the logical window.
  durationMinutes: number;
  // IANA zone the picker is displayed in (BOOK-FE-09). Every month
  // computation — initial month, window, grouping, recovery — uses it.
  timeZone: string;
  api: BookingApi;
  navigate: (href: string) => void;
  now: Clock;
  schedule: Scheduler;
  expiryIntervalMs?: number;
};

export type BookingFormError =
  | 'slotTaken'
  | 'sessionFull'
  | 'required'
  | 'email'
  | 'generic'
  | null;

export type BookingFormState = {
  month: string;
  times: Slot[];
  loading: boolean;
  loaded: boolean;
  selectedStart: string | null;
  selectedDate: string | null;
  name: string;
  email: string;
  error: BookingFormError;
  pending: boolean;
  tick: number;
};

export type SubmitEventLike = { preventDefault?: () => void } | undefined;

export const DEFAULT_EXPIRY_INTERVAL_MS = 30_000;

// Email syntax gate (BOOK-FE-10/13): exactly one `@`, a non-empty local part,
// a domain of two or more dot-separated labels **every one of them non-empty**
// (the domain classes exclude `.`, so `a@b..co`, `a@.b.co`, `a@b.co.` fail),
// and no whitespace. Applied after `trim()`. A syntax gate, not RFC 5322.
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL.test(email.trim());
}

export function offeredSlots(times: Slot[], now: Clock): Slot[] {
  const nowMs = now().getTime();
  return times.filter((slot) => Date.parse(slot.start) >= nowMs);
}

// Starts whose local date falls outside the displayed local month are never
// rendered, even if the backend returned them (BOOK-FE-09 second guard).
export function slotsInMonth(times: Slot[], month: string, timeZone: string): Slot[] {
  return times.filter((slot) => dateKey(slot.start, timeZone).slice(0, 7) === month);
}

export class BookingFormStore {
  private state: BookingFormState;
  private readonly listeners = new Set<() => void>();
  private loadSeq = 0;
  // Synchronous in-flight latch (BOOK-FE-08). Not React state: a second
  // submit in the same tick must see it before any re-render.
  private latch = false;

  constructor(private readonly deps: BookingFormDeps) {
    this.state = {
      // Initial month = the year-month of `now` on the invitee's wall clock,
      // computed here in the client — never on the server (BOOK-FE-09).
      month: monthOf(deps.now(), deps.timeZone),
      times: [],
      loading: false,
      loaded: false,
      selectedStart: null,
      selectedDate: null,
      name: '',
      email: '',
      error: null,
      pending: false,
      tick: 0,
    };
  }

  getState = (): BookingFormState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get now(): Clock {
    return this.deps.now;
  }

  get slug(): string {
    return this.deps.slug;
  }

  get timeZone(): string {
    return this.deps.timeZone;
  }

  isPending(): boolean {
    return this.latch;
  }

  // ---- availability -------------------------------------------------------

  load = async (month: string = this.state.month): Promise<void> => {
    const seq = ++this.loadSeq;
    this.setState({ month, loading: true });
    // Logical window of starts in the displayed zone; the adapter widens the
    // backend's end bound by `durationMinutes`, not the form (BOOK-FE-12).
    const window = monthWindow(month, this.deps.timeZone);
    try {
      const result = await this.deps.api.getSlots({
        slug: this.deps.slug,
        timeMin: window.timeMin,
        timeMax: window.timeMax,
        durationMinutes: this.deps.durationMinutes,
        now: this.deps.now,
      });
      if (seq !== this.loadSeq) {
        return; // a newer load superseded this response
      }
      // The adapter already filtered against a fresh clock on resolve; the
      // render derivation (offeredSlots) filters again at each tick.
      this.setState({
        times: result.times,
        loading: false,
        loaded: true,
        tick: this.state.tick + 1,
      });
    } catch {
      if (seq !== this.loadSeq) {
        return;
      }
      this.setState({ times: [], loading: false, loaded: true, error: 'generic' });
    }
  };

  setMonth = (month: string): Promise<void> => {
    this.setState({ selectedDate: null, selectedStart: null });
    return this.load(month);
  };

  nextMonth = (): Promise<void> => this.setMonth(shiftMonth(this.state.month, 1));

  prevMonth = (): Promise<void> => this.setMonth(shiftMonth(this.state.month, -1));

  selectDate = (date: string): void => {
    this.setState({ selectedDate: date, selectedStart: null });
  };

  // ---- expiry while the picker is open (BOOK-FE-06) -----------------------

  // Re-evaluates the clock: bumps `tick` so the render-time derivation drops
  // elapsed starts, and clears a selection whose start has elapsed.
  tick = (): void => {
    const nowMs = this.deps.now().getTime();
    const selected = this.state.selectedStart;
    const expired = selected !== null && Date.parse(selected) < nowMs;
    this.setState({
      tick: this.state.tick + 1,
      ...(expired ? { selectedStart: null } : {}),
    });
  };

  handleFocus = (): void => this.tick();

  startExpiryTimer = (): (() => void) => {
    const handle = this.deps.schedule.setInterval(
      this.tick,
      this.deps.expiryIntervalMs ?? DEFAULT_EXPIRY_INTERVAL_MS,
    );
    return () => this.deps.schedule.clearInterval(handle);
  };

  // ---- selection ----------------------------------------------------------

  // Selection-time guard: rejects an elapsed start even if its control is
  // still on screen (stale tick); records nothing and re-filters the list.
  selectSlot = (start: string): boolean => {
    if (Date.parse(start) < this.deps.now().getTime()) {
      this.tick();
      return false;
    }
    this.setState({
      selectedStart: start,
      error: null,
      tick: this.state.tick + 1,
    });
    return true;
  };

  clearSelection = (): void => {
    this.setState({ selectedStart: null });
  };

  setName = (name: string): void => {
    this.setState({ name });
  };

  setEmail = (email: string): void => {
    this.setState({ email });
  };

  // ---- submit -------------------------------------------------------------

  submit = async (event?: SubmitEventLike): Promise<void> => {
    event?.preventDefault?.();
    if (this.latch) {
      return; // in flight (or navigating): synchronous no-op
    }
    this.latch = true;
    this.setState({ pending: true });

    const { selectedStart, name, email } = this.state;
    if (!selectedStart || !name.trim() || !email.trim()) {
      this.setState({ error: 'required' });
      this.release();
      return;
    }

    // Email syntax gate (BOOK-FE-10/13) — before the elapsed recheck and
    // before the backend. An invalid address is not a slot conflict: the
    // selection and displayed month are kept, no getSlots, no navigation.
    const trimmedEmail = email.trim();
    if (!isValidEmail(trimmedEmail)) {
      this.setState({ error: 'email' });
      this.release();
      return;
    }

    // Elapsed recheck immediately before the backend call.
    if (Date.parse(selectedStart) < this.deps.now().getTime()) {
      await this.recoverFromConflict(SLOT_UNAVAILABLE);
      this.release();
      return;
    }

    let result;
    try {
      // Exactly one createBooking per submit gesture — no retry loop.
      result = await this.deps.api.createBooking({
        slug: this.deps.slug,
        start: selectedStart,
        invitee: { name: name.trim(), email: trimmedEmail },
        now: this.deps.now,
      });
    } catch {
      this.setState({ error: 'generic' });
      this.release();
      return;
    }

    if (result.ok) {
      // Latch stays set through navigation: a click between the response and
      // the route change is still a no-op.
      this.deps.navigate(`/b/${encodeURIComponent(result.booking.token)}`);
      return;
    }

    if (result.code === SLOT_UNAVAILABLE || result.code === SESSION_FULL) {
      await this.recoverFromConflict(result.code);
      this.release();
      return;
    }

    this.setState({ error: 'generic' });
    this.release();
  };

  // One recovery routine for both 409 codes and the elapsed recheck: pick the
  // copy key by code, clear the selection, advance the displayed month if its
  // tz-aware window has fully elapsed (BOOK-FE-05/09), then refresh.
  recoverFromConflict = async (code: BookingConflictCode): Promise<void> => {
    const nowMs = this.deps.now().getTime();
    let month = this.state.month;
    if (Date.parse(monthWindow(month, this.deps.timeZone).timeMax) <= nowMs) {
      month = monthOf(this.deps.now(), this.deps.timeZone);
    }
    this.setState({
      error: code === SESSION_FULL ? 'sessionFull' : 'slotTaken',
      selectedStart: null,
      selectedDate: month === this.state.month ? this.state.selectedDate : null,
    });
    await this.load(month);
  };

  private release(): void {
    this.latch = false;
    this.setState({ pending: false });
  }

  private setState(patch: Partial<BookingFormState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function createBookingFormStore(deps: BookingFormDeps): BookingFormStore {
  return new BookingFormStore(deps);
}
