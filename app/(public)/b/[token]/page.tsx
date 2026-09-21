import { Logo } from '@/app/components/Logo';
import { getBookingByToken } from '@/lib/api/server';
import type { ConfirmedPublicBooking } from '@/lib/api/types';
import { BOOKING_CANCELLED, BOOKING_CONFIRMED } from '@/lib/booking/booking';
import { t } from '@/lib/copy';

// Confirmation shell (handoff §6.3 spirit): lime panel, Logo, headline and
// subhead from copy/en.json. Renders for any token — the in-memory row may be
// missing on another serverless isolate, and the shell must still show.
//
// Unsupported host first (BOOK-FE-17): the adapter returns a discriminated
// result, and a row whose `hostId` has no canonical host renders the branded
// `states.notFound` shell — Logo and `brand.poweredBy` kept (that is product
// branding, BOOK-FE-18), but no host attribution, no meeting details, no link
// — whatever the row's `status`.
//
// Then status-aware (BOOK-FE-11): the page branches on `booking.status`
// against the exported constants, not on row existence. A row cancelled
// through the existing `cancelBooking` renders the cancellation copy inside
// the same shell — and the book-again anchor only when the adapter resolved
// a destination (BOOK-FE-14/19). The adapter attaches that field by
// resolvability, not by status (BOOK-FE-20); only the cancelled panel below
// reads it. An unknown status renders the no-row shell.
//
// Every `{hostFirstName}` substitution reads `booking.hostFirstName` supplied
// by the adapter (BOOK-FE-15) — this file imports no demo constant.

export const dynamic = 'force-dynamic';

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

function PoweredBy() {
  return <span className="marlo-muted">{t('brand.poweredBy')}</span>;
}

// The cancelled branch is the only place that reads the adapter's book-again
// destination or renders the book-again copy (BOOK-FE-20).
function CancelledPanel({ booking }: { booking: ConfirmedPublicBooking }) {
  return (
    <section className="marlo-panel" data-surface="lime">
      <Logo variant="wordmark" height={25} />
      <Logo variant="mark" height={90} decorative />
      <h1 className="marlo-display marlo-display--hero">
        {t('cancel.done', { hostFirstName: booking.hostFirstName })}
      </h1>
      {booking.bookAgainHref ? (
        <a
          className="marlo-btn marlo-btn--primary"
          href={booking.bookAgainHref}
          data-book-again="true"
        >
          {t('cancel.bookAgain')}
        </a>
      ) : null}
      <PoweredBy />
    </section>
  );
}

function ConfirmedPanel({ booking }: { booking: ConfirmedPublicBooking }) {
  return (
    <>
      <section className="marlo-panel" data-surface="lime">
        <Logo variant="wordmark" height={25} />
        <Logo variant="mark" height={90} decorative />
        <h1 className="marlo-display marlo-display--hero">
          {t('confirmation.headline')}
        </h1>
        {/* The subhead interpolates the invitee's email, which can be a long
            unbroken run; the stylesheet class owns its size and word-breaking
            (BOOK-FE-22) — no inline style here. */}
        <p className="marlo-panel__subhead">
          {t('confirmation.subhead', {
            hostFirstName: booking.hostFirstName,
            inviteeEmail: booking.invitee.email,
          })}
        </p>
        <PoweredBy />
      </section>
      <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
        <dl>
          <dt className="marlo-caps">{t('confirmation.with')}</dt>
          <dd>{booking.hostFirstName}</dd>
          <dt className="marlo-caps">{t('confirmation.where')}</dt>
          <dd>{t('booking.locationMeet')}</dd>
          <dt className="marlo-caps">{t('email.when')}</dt>
          <dd className="time">{formatWhen(booking.start)}</dd>
        </dl>
      </section>
    </>
  );
}

// No row (other serverless isolate) or an unknown status: shell + headline.
function ShellPanel() {
  return (
    <section className="marlo-panel" data-surface="lime">
      <Logo variant="wordmark" height={25} />
      <Logo variant="mark" height={90} decorative />
      <h1 className="marlo-display marlo-display--hero">
        {t('confirmation.headline')}
      </h1>
      <PoweredBy />
    </section>
  );
}

// Unsupported host: the same "not here" shell the booking page renders.
function NotFoundPanel() {
  return (
    <>
      <header className="marlo-header">
        <Logo variant="wordmark" height={25} />
      </header>
      <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
        <h1 className="marlo-display marlo-display--lg">{t('states.notFound')}</h1>
      </section>
      <footer className="marlo-footer">
        <Logo variant="mark" height={24} decorative />
        <PoweredBy />
      </footer>
    </>
  );
}

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const result = getBookingByToken(token);

  if (result?.kind === 'unsupported_host') {
    return (
      <main className="marlo-page" data-confirmation-token={token} data-booking-status="unsupported_host">
        <NotFoundPanel />
      </main>
    );
  }

  const booking = result?.kind === 'booking' ? result : null;

  return (
    <main
      className="marlo-page"
      data-confirmation-token={token}
      data-booking-status={booking?.status || undefined}
    >
      {booking?.status === BOOKING_CONFIRMED ? (
        <ConfirmedPanel booking={booking} />
      ) : booking?.status === BOOKING_CANCELLED ? (
        <CancelledPanel booking={booking} />
      ) : (
        <ShellPanel />
      )}
    </main>
  );
}
