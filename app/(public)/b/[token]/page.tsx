import { Logo } from '@/app/components/Logo';
import { getBookingByToken } from '@/lib/api/server';
import { t } from '@/lib/copy';
import { DEMO_HOST_FIRST_NAME } from '@/lib/demo/seed';

// Confirmation shell (handoff §6.3 spirit): lime panel, Logo, headline and
// subhead from copy/en.json. Renders for any token — the in-memory row may be
// missing on another serverless isolate, and the shell must still show.

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

export default async function ConfirmationPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const booking = getBookingByToken(token);

  return (
    <main className="marlo-page" data-confirmation-token={token}>
      <section className="marlo-panel" data-surface="lime">
        <Logo variant="wordmark" height={25} />
        <Logo variant="mark" height={90} decorative />
        <h1 className="marlo-display marlo-display--hero">
          {t('confirmation.headline')}
        </h1>
        {booking ? (
          <p style={{ fontSize: 'var(--text-lg)' }}>
            {t('confirmation.subhead', {
              hostFirstName: DEMO_HOST_FIRST_NAME,
              inviteeEmail: booking.invitee.email,
            })}
          </p>
        ) : null}
        <span className="marlo-muted">{t('brand.poweredBy')}</span>
      </section>

      {booking ? (
        <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
          <dl>
            <dt className="marlo-caps">{t('confirmation.with')}</dt>
            <dd>{DEMO_HOST_FIRST_NAME}</dd>
            <dt className="marlo-caps">{t('confirmation.where')}</dt>
            <dd>{t('booking.locationMeet')}</dd>
            <dt className="marlo-caps">{t('email.when')}</dt>
            <dd className="time">{formatWhen(booking.start)}</dd>
          </dl>
        </section>
      ) : null}
    </main>
  );
}
