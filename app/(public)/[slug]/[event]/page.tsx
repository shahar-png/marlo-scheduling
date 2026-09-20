import { Logo } from '@/app/components/Logo';
import { getEventTypeBySlug } from '@/lib/availability/event-type';
import { t } from '@/lib/copy';
import { ensureDemoFixtures, hostFirstNameForSlug } from '@/lib/demo/seed';
import { BookingClient } from './BookingClient';
import { monthOf } from './month';

// Public booking page — Server Component. Serializable work only: seed the
// demo fixtures, resolve the event type, and hand plain data props (strings,
// numbers, plain objects) to the client wrapper. Production dependencies are
// created inside BookingClient, never here.

export const dynamic = 'force-dynamic';

export default async function BookingPage({
  params,
}: {
  params: Promise<{ slug: string; event: string }>;
}) {
  const { slug, event } = await params;
  ensureDemoFixtures();
  const eventType = getEventTypeBySlug(event);

  if (!eventType) {
    return (
      <main className="marlo-page">
        <header className="marlo-header">
          <Logo variant="wordmark" height={25} />
        </header>
        <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
          <h1 className="marlo-display marlo-display--lg">{t('states.notFound')}</h1>
        </section>
      </main>
    );
  }

  return (
    <BookingClient
      slug={eventType.slug}
      hostSlug={slug}
      eventMeta={{
        name: eventType.name,
        durationMinutes: eventType.durationMinutes,
        kind: eventType.kind,
      }}
      hostMeta={{ firstName: hostFirstNameForSlug(slug) }}
      initialMonth={monthOf(new Date())}
    />
  );
}
