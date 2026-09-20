'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Logo } from '@/app/components/Logo';
import { t } from '@/lib/copy';
import type { BookingApi, Clock } from '@/lib/api/types';
import {
  createBookingFormStore,
  offeredSlots,
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
// `api`, `navigate`, `now`, `schedule` arrive by props from the client parent
// (BookingClient) — dependency injection is client→client only. Tests render
// this component directly with an in-memory api, a recording navigate, a fixed
// clock, and a manual scheduler, and drive the store's handlers.

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
  initialMonth: string;
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
  generic: 'details.errors.generic',
};

export function BookingForm(props: BookingFormProps) {
  const storeRef = useRef<BookingFormStore | null>(null);
  if (storeRef.current === null) {
    storeRef.current =
      props.store ??
      createBookingFormStore({
        slug: props.slug,
        initialMonth: props.initialMonth,
        api: props.api,
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
      void store.load();
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

  const { timeZone, eventMeta, hostMeta } = props;
  const offered = offeredSlots(state.times, props.now);
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

  return (
    <main className="marlo-page" data-booking-page={props.hostSlug}>
      <header className="marlo-header">
        <Logo variant="wordmark" height={25} />
        <span className="marlo-header__meta">
          {t('booking.timesShownIn', { timezoneLabel: timeZone })}
        </span>
      </header>

      <form
        className="marlo-card"
        onSubmit={store.submit}
        onFocus={store.handleFocus}
        noValidate
        data-pending={state.pending ? 'true' : 'false'}
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
              <div className="marlo-chip">
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
                  {formatMonthTitle(state.month)}
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
