'use client';

// C12 — the guest's change path, rendered from `BookingControlsStore`.
//
// P2 is locked: this page is where a guest reschedules or cancels, so the three
// controls are the product surface, not decoration. All the reasoning lives in
// the store; this component only renders it and wires the handlers.
//
// The **booking details are rendered here too**, from the same store state as
// the controls. Rendering them from the server's initial result instead would
// leave the page showing the old time after a reschedule, and the confirmation
// panel after a cancel — the controls would be the only thing that moved.

import { useSyncExternalStore, useMemo } from 'react';
import { Logo } from '@/app/components/Logo';
import { createApiClient } from '@/lib/api/client';
import { t } from '@/lib/copy';
import type { PublicBooking } from '@/lib/api/types';
import {
  BookingControlsStore,
  calendarStatusLine,
  needsDeliveryRetry,
} from './booking-controls-store';

export type BookingControlsProps = {
  booking: PublicBooking;
  hostFirstName: string;
  bookAgainHref?: string;
};

function formatWhen(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(new Date(iso));
}

export function BookingControls(props: BookingControlsProps) {
  const store = useMemo(
    () =>
      new BookingControlsStore({
        booking: props.booking,
        api: createApiClient(),
        now: () => new Date(),
        wait: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
      }),
    [props.booking],
  );

  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const enabled = store.controlsEnabled();
  const current = state.booking;
  const calendarLine = calendarStatusLine(current);
  const cancelled = current.status === 'cancelled';

  return (
    <>
      {cancelled ? (
        <section className="marlo-panel" data-surface="lime" data-panel="cancelled">
          <Logo variant="wordmark" height={25} />
          <Logo variant="mark" height={90} decorative />
          <h1 className="marlo-display marlo-display--hero">
            {t('cancel.done', { hostFirstName: props.hostFirstName })}
          </h1>
          {props.bookAgainHref ? (
            <a
              className="marlo-btn marlo-btn--primary"
              href={props.bookAgainHref}
              data-book-again="true"
            >
              {t('cancel.bookAgain')}
            </a>
          ) : null}
          <span className="marlo-muted">{t('brand.poweredBy')}</span>
        </section>
      ) : (
        <>
          <section className="marlo-panel" data-surface="lime" data-panel="confirmed">
            <Logo variant="wordmark" height={25} />
            <Logo variant="mark" height={90} decorative />
            <h1 className="marlo-display marlo-display--hero">
              {t('confirmation.headline')}
            </h1>
            <p className="marlo-panel__subhead">
              {t('confirmation.subhead', {
                hostFirstName: props.hostFirstName,
                inviteeEmail: current.invitee.email,
              })}
            </p>
            <span className="marlo-muted">{t('brand.poweredBy')}</span>
          </section>
          <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
            <dl>
              <dt className="marlo-caps">{t('confirmation.with')}</dt>
              <dd>{props.hostFirstName}</dd>
              <dt className="marlo-caps">{t('confirmation.where')}</dt>
              <dd>{t('booking.locationMeet')}</dd>
              <dt className="marlo-caps">{t('email.when')}</dt>
              {/* The CURRENT start: a reschedule moves this line too. */}
              <dd className="time" data-booking-start={current.start}>
                {formatWhen(current.start)}
              </dd>
            </dl>
          </section>
        </>
      )}

      <section
        className="marlo-card"
        data-controls-state={state.state}
        data-booking-revision={current.revision}
      >
        <p data-delivery-email={current.delivery?.email}>{deliveryLine(current)}</p>
        {/* REV13-02: a status line only — no control, no polling. */}
        {calendarLine === null ? null : <p data-calendar-status="pending">{calendarLine}</p>}

        {state.state === 'stalled' ? (
          <div data-stalled="true">
            <p>Another change to this booking is still finishing.</p>
            <button type="button" onClick={() => void store.tryAgain()}>
              Try again
            </button>
            <button type="button" onClick={() => void store.reload()}>
              Reload
            </button>
          </div>
        ) : null}

        {state.state === 'pending' ? <p data-pending="true">Working on it…</p> : null}

        {state.conflict === 'changed' ? (
          <p data-conflict="changed">This booking changed elsewhere — showing the latest</p>
        ) : null}
        {state.conflict === 'slot' ? (
          <p data-conflict="slot">That time just went — pick another.</p>
        ) : null}

        {state.outcomeUnknown ? (
          // C12: an unknown outcome offers a RELOAD, never a re-submit.
          <div data-outcome-unknown="true">
            <p>We&rsquo;re not sure that went through.</p>
            <button type="button" onClick={() => void store.reload()}>
              Reload
            </button>
          </div>
        ) : state.state === 'error' ? (
          // Every other error keeps the same request and the same
          // `expectedRevision` behind an explicit Try again (C12).
          <div data-error={state.errorCode ?? 'generic'}>
            <p>That didn&rsquo;t go through.</p>
            {state.stalledRequest === null ? null : (
              <button type="button" onClick={() => void store.tryAgain()}>
                Try again
              </button>
            )}
          </div>
        ) : null}

        {cancelled ? (
          // The cancelled panel carries no Reschedule or Cancel control — only
          // the delivery status and, when it is not `sent`, the retry (REV3-07).
          needsDeliveryRetry(current) ? (
            <button
              type="button"
              data-control="retry-notification"
              disabled={!enabled}
              onClick={() => void store.resend()}
            >
              Retry notification
            </button>
          ) : null
        ) : (
          <div data-controls="confirmed">
            <button
              type="button"
              data-control="reschedule"
              disabled={!enabled}
              onClick={() => void store.openPicker()}
            >
              Reschedule
            </button>
            {state.cancelArmed ? (
              <span data-cancel-confirm="true">
                <button
                  type="button"
                  data-control="cancel-confirm"
                  disabled={!enabled}
                  onClick={() => void store.confirmCancel()}
                >
                  Yes, cancel it
                </button>
                <button type="button" onClick={store.disarmCancel}>
                  Keep it
                </button>
              </span>
            ) : (
              <button
                type="button"
                data-control="cancel"
                disabled={!enabled}
                onClick={store.armCancel}
              >
                Cancel
              </button>
            )}
            <button
              type="button"
              data-control="resend"
              disabled={!enabled}
              onClick={() => void store.resend()}
            >
              Resend confirmation
            </button>
          </div>
        )}

        {state.pickerOpen ? (
          <div data-picker="open">
            {state.loadingTimes ? (
              <p>Loading times…</p>
            ) : (
              state.times.map((slot) => (
                <button
                  key={slot.start}
                  type="button"
                  data-slot={slot.start}
                  disabled={!enabled}
                  onClick={() => void store.selectSlot(slot.start)}
                >
                  {slot.start}
                </button>
              ))
            )}
            <button type="button" onClick={store.closePicker}>
              Close
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function deliveryLine(booking: PublicBooking): string {
  const cancelled = booking.status === 'cancelled';
  const noun = cancelled ? 'Cancellation emails' : 'Confirmation emails';
  switch (booking.delivery?.email) {
    case 'sent':
      return `${noun} sent`;
    case 'failed':
      return `${noun} failed`;
    default:
      return `${noun} pending`;
  }
}
