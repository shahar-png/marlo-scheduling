import {
  SESSION_FULL,
  SLOT_UNAVAILABLE,
  type BookingApi,
  type BookingConflictCode,
  type Clock,
  type Slot,
} from '@/lib/api/types';
import { monthOf, monthWindow, shiftMonth } from './month';

// State + the real event handlers behind <BookingForm>. Plain TypeScript so
// tests drive the form's own handlers (selectSlot / submit / tick) without a
// browser, then render the component for markup assertions. Every dependency
// (api, navigate, clock, interval scheduler) is injected — nothing here reaches
// for globals.

export type Scheduler = {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};

export type BookingFormDeps = {
  slug: string;
  initialMonth: string;
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

export function offeredSlots(times: Slot[], now: Clock): Slot[] {
  const nowMs = now().getTime();
  return times.filter((slot) => Date.parse(slot.start) >= nowMs);
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
      month: deps.initialMonth,
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

  isPending(): boolean {
    return this.latch;
  }

  // ---- availability -------------------------------------------------------

  load = async (month: string = this.state.month): Promise<void> => {
    const seq = ++this.loadSeq;
    this.setState({ month, loading: true });
    const window = monthWindow(month);
    try {
      const result = await this.deps.api.getSlots({
        slug: this.deps.slug,
        timeMin: window.timeMin,
        timeMax: window.timeMax,
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
        invitee: { name: name.trim(), email: email.trim() },
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
  // window has fully elapsed (BOOK-FE-05), then refresh availability.
  recoverFromConflict = async (code: BookingConflictCode): Promise<void> => {
    const nowMs = this.deps.now().getTime();
    let month = this.state.month;
    if (Date.parse(monthWindow(month).timeMax) <= nowMs) {
      month = monthOf(this.deps.now());
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
