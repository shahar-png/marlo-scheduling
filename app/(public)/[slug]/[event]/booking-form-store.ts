import {
  SESSION_FULL,
  SLOT_UNAVAILABLE,
  UNKNOWN_ERROR,
  type BookingApi,
  type BookingConflictCode,
  type Clock,
  type CreateBookingInput,
  type CreateBookingResult,
  type Slot,
} from '@/lib/api/types';
import { dateKey, monthOf, monthWindow, shiftMonth } from './month';
import {
  clearRecord,
  DEFAULT_RETRY_AFTER_SECONDS,
  isAutoReplayable,
  isReplayable,
  isTerminalForKey,
  readRecord,
  writeRecord,
  type RecordStorage,
  type SubmissionPayload,
  type SubmissionRecord,
} from './submission-record';

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
  /**
   * C1 — the owner this event type belongs to. Absent on the retained legacy
   * fixture surface, which resolves within the `demo` owner.
   */
  ownerSlug?: string;
  /**
   * C9 — where the unresolved-submission record lives (`sessionStorage` in the
   * browser). Without it the store behaves exactly as it did before create
   * idempotency existed: no record, no key, no recovery.
   */
  storage?: RecordStorage | null;
  /** C9 — mints one key per submission. */
  newKey?: () => string;
  /** C9 — the replay entry point that bypasses the new-submission gates. */
  recover?: (input: CreateBookingInput) => Promise<CreateBookingResult>;
  /** Diagnostics for dropped late responses (`stale_response_ignored`). */
  log?: (code: string, fields: Record<string, unknown>) => void;
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
  /**
   * C9 — the wait before the **single automatic replay** of a non-terminal 409
   * `operation_in_progress`. Injected so tests drive it deterministically;
   * defaults to a plain timer.
   */
  waitFor?: (ms: number) => Promise<void>;
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
  /**
   * C9 reload recovery. `idle` is the ordinary form. `recovering` hides it
   * behind "Finishing your booking…" while an unresolved record is replayed;
   * `stalled` is the exit when that replay could not be resolved, offering
   * **Try again** (replay the same key and payload) and **Start over**
   * (explicitly discard the record).
   */
  recovery: 'idle' | 'recovering' | 'stalled';
  /** Shown once after a terminal 4xx resolved an unresolved record. */
  recoveryNotice: boolean;
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

/** The server's `retryAfterSeconds`, or C9's default when it sent none. */
function retryAfterOf(result: CreateBookingResult): number {
  if (!result.ok && 'retryAfterSeconds' in result && typeof result.retryAfterSeconds === 'number') {
    return result.retryAfterSeconds;
  }
  return DEFAULT_RETRY_AFTER_SECONDS;
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
  /** C9 — the key whose one automatic replay has already been spent. */
  private autoReplayedKey: string | null = null;
  /** C9 — the authoritative unresolved record; storage is only its cache. */
  private pendingRecord: SubmissionRecord | null = null;

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
      // C9: an unresolved record is discovered here, but replayed by
      // `start()` — a constructor cannot await.
      recovery: this.unresolved() === null ? 'idle' : 'recovering',
      recoveryNotice: false,
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

  // ---- C9 unresolved-submission record ------------------------------------

  private get ownerSlug(): string {
    return this.deps.ownerSlug ?? 'demo';
  }

  private get storage(): RecordStorage | null {
    return this.deps.storage ?? null;
  }

  /**
   * The record for *this* page's event, if one survived a lost response.
   *
   * The in-memory copy is **authoritative**: `sessionStorage` may be absent or
   * may throw, and losing the key there must never make the store forget a
   * submission that is already in flight — which would drop its 201 on the
   * floor and let the guest book a second slot.
   */
  unresolved(): SubmissionRecord | null {
    if (this.pendingRecord !== null) {
      return this.pendingRecord;
    }
    return readRecord(this.storage, this.ownerSlug, this.deps.slug);
  }

  /**
   * The entry point the page calls instead of `load()`.
   *
   * An unresolved record is replayed **before availability is loaded** (C9 /
   * REV3-06): the booking may already exist, and showing a picker first would
   * invite the guest to book a second slot.
   */
  start = async (): Promise<void> => {
    const record = this.unresolved();
    if (record === null) {
      await this.load();
      return;
    }
    await this.replay(record);
  };

  /** "Try again" in the `stalled` state — the same key, the same payload. */
  retryRecovery = async (): Promise<void> => {
    const record = this.unresolved();
    if (record === null) {
      this.setState({ recovery: 'idle' });
      await this.load();
      return;
    }
    // A manual retry restores the one automatic replay, exactly as C12's
    // `stalled` → **Try again** re-enters `pending` with a fresh one.
    this.autoReplayedKey = null;
    this.setState({ recovery: 'recovering' });
    await this.replay(record);
  };

  /** "Start over" — an **explicit** discard, never an implicit one. */
  discardRecovery = async (): Promise<void> => {
    this.deps.log?.('submission_discarded', {
      key: this.unresolved()?.key ?? null,
    });
    this.clearUnresolved();
    this.setState({ recovery: 'idle' });
    await this.load();
  };

  private async replay(record: SubmissionRecord): Promise<void> {
    const send = this.deps.recover ?? this.deps.api.createBooking;
    let result: CreateBookingResult;
    try {
      result = await send(this.inputFor(record));
    } catch {
      // A network error resolves nothing: the record is retained.
      this.setState({ recovery: 'stalled' });
      return;
    }

    if (!this.isCurrentKey(record.key)) {
      // The record was cleared or replaced while this was in flight: whatever
      // came back is for a key the client no longer owns (REV8-01).
      this.dropStaleResponse(record.key, result);
      return;
    }

    if (result.ok) {
      this.clearUnresolved();
      this.deps.navigate(`/b/${encodeURIComponent(result.booking.token)}`);
      return;
    }

    const { status, code } = this.classify(result);
    if (isAutoReplayable(status, code)) {
      await this.autoReplay(record, retryAfterOf(result));
      return;
    }
    if (isReplayable(status, code)) {
      this.setState({ recovery: 'stalled' });
      return;
    }
    if (isTerminalForKey(status, code)) {
      // "Your earlier booking didn't go through" — one notice, then the
      // ordinary flow with availability loaded.
      this.clearUnresolved();
      this.setState({ recovery: 'idle', recoveryNotice: true });
      await this.load();
      return;
    }
    this.setState({ recovery: 'stalled' });
  }

  /**
   * C9 / AC-19(f′) — waits the server's own `retryAfterSeconds` and replays the
   * stored key and payload **once**, automatically. A second
   * `operation_in_progress` is the exit to `stalled`, where the guest drives it
   * with **Try again** (which restores the one automatic replay) or **Start
   * over**. Without this the guest had to intervene manually even though the
   * server had named a window (LIVE-REVIEW-11).
   */
  private async autoReplay(
    record: SubmissionRecord,
    retryAfterSeconds: number,
  ): Promise<void> {
    if (this.autoReplayedKey === record.key) {
      this.setState({ recovery: 'stalled', error: null });
      return;
    }
    this.autoReplayedKey = record.key;
    this.setState({ recovery: 'recovering', error: null });
    await this.wait(Math.max(0, retryAfterSeconds) * 1000);
    if (!this.isCurrentKey(record.key)) {
      // Discarded or superseded while waiting: nothing to replay.
      return;
    }
    await this.replay(record);
  }

  private wait(ms: number): Promise<void> {
    const waitFor = this.deps.waitFor;
    if (waitFor !== undefined) {
      return waitFor(ms);
    }
    return new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private inputFor(record: SubmissionRecord): CreateBookingInput {
    return {
      slug: record.payload.eventSlug,
      start: record.payload.start,
      invitee: record.payload.invitee,
      idempotencyKey: record.key,
      ...(this.deps.ownerSlug === undefined ? {} : { ownerSlug: this.deps.ownerSlug }),
      ...(record.payload.notes === undefined ? {} : { notes: record.payload.notes }),
      now: this.deps.now,
    };
  }

  private isCurrentKey(key: string): boolean {
    const current = this.unresolved();
    return current !== null && current.key === key;
  }

  private dropStaleResponse(key: string, result: CreateBookingResult): void {
    const { status } = this.classify(result);
    this.deps.log?.('stale_response_ignored', { key, status });
  }

  private classify(result: CreateBookingResult): { status: number; code: string | null } {
    if (result.ok) {
      return { status: 201, code: null };
    }
    if (result.code !== UNKNOWN_ERROR) {
      return { status: 409, code: result.code };
    }
    return { status: result.status ?? 0, code: result.error ?? null };
  }

  private rememberUnresolved(record: SubmissionRecord): void {
    this.pendingRecord = record;
    writeRecord(this.storage, record);
  }

  private clearUnresolved(): void {
    this.pendingRecord = null;
    clearRecord(this.storage, this.ownerSlug, this.deps.slug);
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
        // C1: availability is read for the SAME owner the booking is posted to.
        ...(this.deps.ownerSlug === undefined ? {} : { ownerSlug: this.deps.ownerSlug }),
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

    // C9: a new key is minted **only** when nothing is unresolved. An existing
    // record must be resolved or explicitly discarded first, so a lost response
    // can never be stranded by a second submission overwriting its key.
    const outstanding = this.unresolved();
    if (outstanding !== null) {
      this.setState({ recovery: 'stalled' });
      this.release();
      return;
    }

    // The record is written **before** the request, so a lost response always
    // leaves something to replay. Every later attempt sends this stored
    // payload, never whatever the form holds by then.
    const key = this.deps.newKey?.();
    const payload: SubmissionPayload = {
      ownerSlug: this.ownerSlug,
      eventSlug: this.deps.slug,
      start: selectedStart,
      invitee: { name: name.trim(), email: trimmedEmail },
    };
    if (key !== undefined) {
      this.rememberUnresolved({
        key,
        payload,
        startedAt: new Date(this.deps.now().getTime()).toISOString(),
      });
    }

    let result;
    try {
      // Exactly one createBooking per submit gesture — no retry loop. Retry
      // safety is the key's job, not a loop's.
      result = await this.deps.api.createBooking({
        slug: this.deps.slug,
        start: selectedStart,
        invitee: payload.invitee,
        now: this.deps.now,
        ...(this.deps.ownerSlug === undefined ? {} : { ownerSlug: this.deps.ownerSlug }),
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });
    } catch {
      // The response is lost but the create may well have committed. This is
      // the unresolved state, not an ordinary error: the form is replaced by
      // the recovery panel so the guest replays this key rather than picking
      // another slot and booking twice.
      if (key !== undefined) {
        this.setState({ recovery: 'stalled', error: null });
      } else {
        this.setState({ error: 'generic' });
      }
      this.release();
      return;
    }

    if (key !== undefined && !this.isCurrentKey(key)) {
      this.dropStaleResponse(key, result);
      this.release();
      return;
    }

    if (result.ok) {
      this.clearUnresolved();
      // Latch stays set through navigation: a click between the response and
      // the route change is still a no-op.
      this.deps.navigate(`/b/${encodeURIComponent(result.booking.token)}`);
      return;
    }

    if (result.code === SLOT_UNAVAILABLE || result.code === SESSION_FULL) {
      // Terminal, and durably fenced server-side (REV8-01): safe to clear.
      this.clearUnresolved();
      await this.recoverFromConflict(result.code);
      this.release();
      return;
    }

    const { status, code } = this.classify(result);
    if (isTerminalForKey(status, code)) {
      this.clearUnresolved();
      this.setState({ error: 'generic' });
      this.release();
      return;
    }
    if (key !== undefined && isAutoReplayable(status, code)) {
      // The original create is still running somewhere and the server named a
      // window: wait it out and replay this key once, automatically (C9).
      this.release();
      const record = this.unresolved();
      if (record !== null) {
        await this.autoReplay(record, retryAfterOf(result));
      }
      return;
    }
    if (key !== undefined && isReplayable(status, code)) {
      // The original create may still be alive: keep the record and let the
      // guest replay it rather than minting a second key.
      this.setState({ recovery: 'stalled', error: null });
    } else {
      this.setState({ error: 'generic' });
    }
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
