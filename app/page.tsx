import { Logo } from './components/Logo';
import { t } from '@/lib/copy';
import {
  DEMO_BOOKING_PATH,
  DEMO_DURATION_MINUTES,
  DEMO_EVENT_NAME,
  DEMO_HOST_FIRST_NAME,
} from '@/lib/demo/seed';

export default function HomePage() {
  return (
    <main className="marlo-page">
      <header className="marlo-header">
        <Logo variant="wordmark" height={25} />
        <span className="marlo-header__meta">{t('brand.poweredBy')}</span>
      </header>
      <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
        <p className="marlo-caps">{t('brand.name')}</p>
        <h1 className="marlo-display marlo-display--lg">Marlo Scheduling</h1>
        <p className="marlo-muted">
          {t('booking.headline', { hostFirstName: DEMO_HOST_FIRST_NAME })} —{' '}
          {DEMO_EVENT_NAME} ·{' '}
          {t('booking.duration', { minutes: DEMO_DURATION_MINUTES })}
        </p>
        <p>
          <a className="marlo-btn marlo-btn--primary" href={DEMO_BOOKING_PATH}>
            {t('booking.next')}
          </a>
        </p>
      </section>
      <footer className="marlo-footer">
        <Logo variant="mark" height={24} decorative />
        <span>{t('brand.poweredBy')}</span>
      </footer>
    </main>
  );
}
