'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Logo } from '@/app/components/Logo';
import { t } from '@/lib/copy';
import type { ApiClient } from '@/lib/api/client';
import type { BookingApi, Clock } from '@/lib/api/types';
import {
  createBookingFormStore,
  offeredSlots,
  slotsInMonth,
  type BookingFormError,
  type BookingFormStore,
  type Scheduler,
} from './booking-form-store';
import {
  dateKey,
  formatDay,
  formatLongDate,
  formatMonthTitle,
  formatTime,
} from './month';

// Presentational + stateful booking form (handoff §6.1–6.2, time-boxed).
// `api`, `navigate`, `now`, `schedule`, `timeZone` arrive by props from the
// client parent (BookingClient) — dependency injection is client→client only,
// and the zone is always injected (this file never reads the machine zone). Tests
// render this component directly with an in-memory api, a recording navigate,
// a fixed clock, an explicit zone, and a manual scheduler, and drive the
// store's handlers.
//
// Host chrome (BOOK-FE-15): `hostMeta` / `hostSlug` are the canonical host's,
// resolved by the Server page from the event type's `hostId` — the form never
// receives the URL segment, so it cannot show a name derived from it.

export type BookingEventMeta = {
  name: string;
  durationMinutes: number;
  kind: string;
};

export type BookingHostMeta = {
  firstName: string;
};

export type BookingFormProps = {
  slug: string;
  hostSlug: string;
  eventMeta: BookingEventMeta;
  hostMeta: BookingHostMeta;
  // IANA zone the picker is displayed in; drives every month computation.
  timeZone: string;
  api: BookingApi;
  navigate: (href: string) => void;
  now: Clock;
  schedule: Scheduler;
  expiryIntervalMs?: number;
  // Test seam: drive a store you created, then render. Production never sets it.
  store?: BookingFormStore;
};

const ERROR_COPY_KEY: Record<Exclude<BookingFormError, null>, string> = {
  slotTaken: 'details.errors.slotTaken',
  sessionFull: 'details.errors.sessionFull',
  required: 'details.errors.required',
  email: 'details.errors.email',
  generic: 'details.errors.generic',
};

/** `sessionStorage` is unavailable during SSR and in privacy modes. */
function sessionStorageOrNull() {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function hasRecover(
  api: BookingApi,
): api is BookingApi & { recoverBooking: ApiClient['recoverBooking'] } {
  return typeof (api as { recoverBooking?: unknown }).recoverBooking === 'function';
}

export function BookingForm(props: BookingFormProps) {
  const storeRef = useRef<BookingFormStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current =
      props.store ??
      createBookingFormStore({
        slug: props.slug,
        // C1/C9: the record is keyed per owner+event, and the create is sent to
        // the owner-scoped route. `hostSlug` is the canonical owner the Server
        // page resolved — never the URL segment.
        ownerSlug: props.hostSlug,
        durationMinutes: props.eventMeta.durationMinutes,
        timeZone: props.timeZone,
        api: props.api,
        storage: sessionStorageOrNull(),
        newKey: () => crypto.randomUUID(),
        ...(hasRecover(props.api) ? { recover: props.api.recoverBooking } : {}),
        navigate: props.navigate,
        now: props.now,
        schedule: props.schedule,
        expiryIntervalMs: props.expiryIntervalMs,
      });
  }
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    if (!store.getState().loaded && !store.getState().loading) {
      // C9: `start()` resolves an unresolved submission **before** it loads
      // availability. Showing a picker first would invite the guest to book a
      // second slot while the first one may already have committed.
      void store.start();
    }
    const stopTimer = store.startExpiryTimer();
    window.addEventListener('focus', store.handleFocus);
    document.addEventListener('visibilitychange', store.handleFocus);
    return () => {
      stopTimer();
      window.removeEventListener('focus', store.handleFocus);
      document.removeEventListener('visibilitychange', store.handleFocus);
    };
  }, [store]);

  const { eventMeta, hostMeta } = props;
  const timeZone = store.timeZone;
  // Render-time derivation: drop elapsed starts against a fresh clock, then
  // drop any start whose local date is outside the displayed local month.
  const offered = slotsInMonth(offeredSlots(state.times, props.now), state.month, timeZone);
  const days = new Map<string, typeof offered>();
  for (const slot of offered) {
    const key = dateKey(slot.start, timeZone);
    const list = days.get(key);
    if (list) {
      list.push(slot);
    } else {
      days.set(key, [slot]);
    }
  }
  const dayKeys = [...days.keys()];
  const activeDate =
    state.selectedDate && days.has(state.selectedDate)
      ? state.selectedDate
      : dayKeys[0] ?? null;
  const daySlots = activeDate ? days.get(activeDate) ?? [] : [];
  const selectedStart =
    state.selectedStart && offered.some((slot) => slot.start === state.selectedStart)
      ? state.selectedStart
      : null;
  const errorCopy = state.error ? t(ERROR_COPY_KEY[state.error]) : null;

  // C9: while an unresolved submission is being replayed the form is hidden —
  // the booking may already exist, and a visible picker invites a second one.
  if (state.recovery !== 'idle') {
    return (
      <main
        className="marlo-page"
        data-booking-page={props.hostSlug}
        data-recovery={state.recovery}
      >
        <header className="marlo-header">
          <Logo variant="wordmark" height={25} />
        </header>
        <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
          <p>Finishing your booking…</p>
          {state.recovery === 'stalled' ? (
            <>
              <button type="button" onClick={() => void store.retryRecovery()}>
                Try again
              </button>
              <button type="button" onClick={() => void store.discardRecovery()}>
                Start over
              </button>
            </>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="marlo-page" data-booking-page={props.hostSlug}>
      <header className="marlo-header">
        <Logo variant="wordmark" height={25} />
        <span className="marlo-header__meta">
          {t('booking.timesShownIn', { timezoneLabel: timeZone })}
        </span>
      </header>

      {state.recoveryNotice ? (
        <p data-recovery-notice="true">Your earlier booking didn&rsquo;t go through.</p>
      ) : null}

      <form
        className="marlo-card"
        onSubmit={store.submit}
        onFocus={store.handleFocus}
        noValidate
        data-pending={state.pending ? 'true' : 'false'}
        data-month={state.month}
        data-selected-start={selectedStart ?? undefined}
      >
        <section aria-label={eventMeta.name}>
          <div className="marlo-meta" style={{ marginBottom: 'var(--s-4)' }}>
            <span className="marlo-avatar" aria-hidden="true">
              {hostMeta.firstName.slice(0, 1)}
            </span>
            <strong style={{ color: 'var(--ink)' }}>{hostMeta.firstName}</strong>
          </div>
          <h1 className="marlo-display marlo-display--lg">
            {t('booking.headline', { hostFirstName: hostMeta.firstName })}
          </h1>
          <p style={{ fontWeight: 600 }}>{eventMeta.name}</p>
          <div className="marlo-meta">
            <span className="time">
              {t('booking.duration', { minutes: eventMeta.durationMinutes })}
            </span>
            <span>{t('booking.locationMeet')}</span>
          </div>
        </section>

        <section>
          {errorCopy ? (
            <div className="marlo-error" role="alert" data-error={state.error}>
              {errorCopy}
            </div>
          ) : null}

          {selectedStart ? (
            <div data-step="details">
              <div className="marlo-chip" data-selected-slot={selectedStart}>
                <div>
                  <strong>{eventMeta.name}</strong>
                  <div className="marlo-muted time">
                    {formatLongDate(selectedStart, timeZone)} ·{' '}
                    {formatTime(selectedStart, timeZone)} ·{' '}
                    {t('booking.duration', { minutes: eventMeta.durationMinutes })}
                  </div>
                </div>
                <button
                  type="button"
                  className="marlo-btn marlo-btn--ghost"
                  onClick={store.clearSelection}
                  disabled={state.pending}
                >
                  {t('details.change')}
                </button>
              </div>
              <h2 className="marlo-display marlo-display--md">
                {t('details.headline')}
              </h2>
              <div className="marlo-field">
                <label htmlFor="booking-name">{t('details.name')}</label>
                <input
                  id="booking-name"
                  name="name"
                  autoComplete="name"
                  required
                  value={state.name}
                  onChange={(event) => store.setName(event.target.value)}
                  disabled={state.pending}
                />
              </div>
              <div className="marlo-field">
                <label htmlFor="booking-email">{t('details.email')}</label>
                <input
                  id="booking-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={state.email}
                  onChange={(event) => store.setEmail(event.target.value)}
                  disabled={state.pending}
                  aria-invalid={state.error === 'email' ? 'true' : undefined}
                />
              </div>
              <button
                type="submit"
                className="marlo-btn marlo-btn--primary"
                data-submit="true"
                disabled={state.pending}
                aria-disabled={state.pending ? 'true' : undefined}
                aria-busy={state.pending ? 'true' : undefined}
              >
                {t('details.submit')}
              </button>
              <p className="marlo-footnote">{t('details.footnote')}</p>
            </div>
          ) : (
            <div data-step="slots">
              <div className="marlo-month">
                <button
                  type="button"
                  className="marlo-btn marlo-btn--ghost"
                  aria-label={t('booking.prevMonth')}
                  onClick={() => void store.prevMonth()}
                >
                  ‹
                </button>
                <h2 className="marlo-display marlo-display--md" data-month={state.month}>
                  {formatMonthTitle(state.month, timeZone)}
                </h2>
                <button
                  type="button"
                  className="marlo-btn marlo-btn--ghost"
                  aria-label={t('booking.nextMonth')}
                  onClick={() => void store.nextMonth()}
                >
                  ›
                </button>
              </div>

              {state.loading || !state.loaded ? (
                <p className="marlo-muted" aria-live="polite">
                  {t('booking.loadingSlots')}
                </p>
              ) : dayKeys.length === 0 ? (
                <p className="marlo-muted" data-empty="true">
                  {t('booking.emptyMonth')}
                </p>
              ) : (
                <>
                  <div className="marlo-days">
                    {dayKeys.map((key) => (
                      <button
                        key={key}
                        type="button"
                        className="marlo-btn marlo-btn--day"
                        data-date={key}
                        aria-pressed={key === activeDate}
                        onClick={() => store.selectDate(key)}
                      >
                        {formatDay(days.get(key)![0].start, timeZone)}
                      </button>
                    ))}
                  </div>
                  <div className="marlo-slots">
                    {daySlots.map((slot) => (
                      <button
                        key={slot.start}
                        type="button"
                        className="marlo-btn marlo-btn--slot time"
                        data-slot={slot.start}
                        onClick={() => store.selectSlot(slot.start)}
                      >
                        <span>{formatTime(slot.start, timeZone)}</span>
                        {slot.spotsRemaining !== undefined ? (
                          <small>
                            {t('booking.spotsLeft', { count: slot.spotsRemaining })}
                          </small>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </form>

      <footer className="marlo-footer">
        <Logo variant="mark" height={24} decorative />
        <span>{t('brand.poweredBy')}</span>
      </footer>
    </main>
  );
}
