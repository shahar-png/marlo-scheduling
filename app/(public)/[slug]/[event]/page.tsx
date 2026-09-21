import { redirect } from 'next/navigation';
import { Logo } from '@/app/components/Logo';
import { publicBookingPath } from '@/lib/api/public-path';
import { getEventTypeBySlug } from '@/lib/availability/event-type';
import { t } from '@/lib/copy';
import { ensureDemoFixtures, hostMetaForHostId } from '@/lib/demo/seed';
import { BookingClient } from './BookingClient';

// Public booking page — Server Component. Serializable work only: seed the
// demo fixtures, resolve the event type and its canonical host, and hand plain
// data props (strings, numbers, plain objects) to the client wrapper.
// Production dependencies are created inside BookingClient, never here. The
// server does not know the invitee's time zone, so it does not pick the
// displayed month either (BOOK-FE-09) — the client derives it after mount.
//
// Host chrome (BOOK-FE-15): `[slug]` is never a source of chrome. The host is
// resolved from the event type's `hostId` through `hostMetaForHostId`; an
// alias that differs from the canonical host slug is canonicalized with
// `redirect()`, and the props passed down are the canonical host's either way.
//
// Safe paths (BOOK-FE-19): the canonical path comes from the shared
// constructor. A store-backed event type whose slug is unrepresentable has no
// public booking page — the not-found shell, no redirect, no BookingClient.

export const dynamic = 'force-dynamic';

function NotFoundShell() {
  return (
    <main className="marlo-page">
      <header className="marlo-header">
        <Logo variant="wordmark" height={25} />
      </header>
      <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
        <h1 className="marlo-display marlo-display--lg">{t('states.notFound')}</h1>
      </section>
      <footer className="marlo-footer">
        <Logo variant="mark" height={24} decorative />
        <span>{t('brand.poweredBy')}</span>
      </footer>
    </main>
  );
}

export default async function BookingPage({
  params,
}: {
  params: Promise<{ slug: string; event: string }>;
}) {
  const { slug, event } = await params;
  ensureDemoFixtures();
  const eventType = getEventTypeBySlug(event);

  if (!eventType) {
    return <NotFoundShell />;
  }

  const host = hostMetaForHostId(eventType.hostId);
  if (!host) {
    // A public page for a non-demo host is a non-goal; never invent a name.
    return <NotFoundShell />;
  }

  const canonicalPath = publicBookingPath(host.slug, eventType.slug);
  if (canonicalPath === null) {
    return <NotFoundShell />;
  }

  if (slug !== host.slug) {
    // Temporary redirect; `redirect()` throws, so nothing after it renders.
    redirect(canonicalPath);
  }

  return (
    <BookingClient
      slug={eventType.slug}
      hostSlug={host.slug}
      eventMeta={{
        name: eventType.name,
        durationMinutes: eventType.durationMinutes,
        kind: eventType.kind,
      }}
      hostMeta={{ firstName: host.firstName }}
    />
  );
}
