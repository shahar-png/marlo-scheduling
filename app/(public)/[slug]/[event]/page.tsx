import { Logo } from '@/app/components/Logo';
import { publicBookingPath } from '@/lib/api/public-path';
import { LifecycleError } from '@/lib/booking/errors';
import { ensureOwnerFixtures } from '@/lib/booking/fixtures';
import { resolveScope } from '@/lib/booking/service';
import { t } from '@/lib/copy';
import { BookingClient } from './BookingClient';

// Public booking page — Server Component. Serializable work only: seed the
// demo fixtures, resolve the event type and its canonical host, and hand plain
// data props (strings, numbers, plain objects) to the client wrapper.
// Production dependencies are created inside BookingClient, never here. The
// server does not know the invitee's time zone, so it does not pick the
// displayed month either (BOOK-FE-09) — the client derives it after mount.
//
// Owner-scoped resolution (P1 / C1): `[slug]` **is** the owner slug and the
// page resolves `(ownerSlug, eventSlug)` through the selected catalog — the
// fixture registry in memory mode, Postgres in pg mode. Two owners may both
// offer `intro-30` and each gets their own page, their own availability, and
// their own chrome. `/demo/intro-30` is just the fixture owner's page.
//
// Safe paths (BOOK-FE-19): the canonical path comes from the shared
// constructor. A store-backed event type whose slug is unrepresentable has no
// public booking page — the not-found shell, no BookingClient.

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

  let scope: Awaited<ReturnType<typeof resolveScope>>;
  try {
    // `[slug]` **is** the owner slug (P1/C1). Fixture owners exist only in
    // memory mode; in pg mode owners come from sign-in materialization, so an
    // unknown slug stays a 404 here rather than falling back to the demo
    // catalog. Seeding resolves the runtime, so it belongs inside the same
    // boundary as the catalog resolution it precedes (REV-07).
    await ensureOwnerFixtures(slug);
    scope = await resolveScope(slug, event);
  } catch (error) {
    // A reserved or unknown owner, an unknown event under a known owner, and a
    // kind the live path refuses all render the branded not-found shell.
    if (error instanceof LifecycleError) {
      return <NotFoundShell />;
    }
    throw error;
  }

  // A slug the path constructor rejects has no public booking page.
  if (publicBookingPath(scope.owner.slug, scope.eventType.slug) === null) {
    return <NotFoundShell />;
  }

  return (
    <BookingClient
      slug={scope.eventType.slug}
      // Host chrome is THIS owner's, resolved from the catalog — never a demo
      // fallback and never derived from anything but the resolved owner.
      hostSlug={scope.owner.slug}
      eventMeta={{
        name: scope.eventType.name,
        durationMinutes: scope.eventType.durationMinutes,
        kind: scope.eventType.kind,
      }}
      hostMeta={{ firstName: scope.owner.firstName }}
    />
  );
}
