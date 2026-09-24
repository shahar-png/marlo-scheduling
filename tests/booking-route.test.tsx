import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { BookingClient } from '../app/(public)/[slug]/[event]/BookingClient';
import BookingPage from '../app/(public)/[slug]/[event]/page';
import {
  createEventType,
  getEventTypeBySlug,
  resetEventTypes,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';
import { resetBookings } from '../lib/booking/booking';
import { t } from '../lib/copy';
import * as seed from '../lib/demo/seed';
import {
  DEMO_HOST_FIRST_NAME,
  DEMO_HOST_ID,
  ensureDemoFixtures,
  hostMetaForHostId,
} from '../lib/demo/seed';

// BOOK-FE-15/19: host chrome comes from the canonical host of the event being
// booked, never from the URL `[slug]`; every public path is built by the
// shared constructor. The Server page is *called*, not rendered, for the
// BookingClient cases (useRouter has no app-router context under
// react-dom/server); the not-found branch is a plain element and is rendered.

const ROOT = process.cwd();

type PageParams = { slug: string; event: string };

function page(params: PageParams) {
  return BookingPage({ params: Promise.resolve(params) });
}

function seedEventType(hostId: string, slug: string, ownerId?: string) {
  const schedule = createAvailabilitySchedule({
    hostId,
    timezone: 'UTC',
    windows: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: '09:00', end: '20:00' })),
  });
  return createEventType({
    hostId,
    slug,
    name: 'Intro call',
    durationMinutes: 30,
    availabilityScheduleId: schedule.id,
    kind: 'one_on_one',
    ...(ownerId === undefined ? {} : { ownerId }),
  });
}

function isRedirectTo(pathname: string) {
  return (err: unknown) => {
    const digest = (err as { digest?: unknown }).digest;
    return (
      typeof digest === 'string' &&
      digest.startsWith('NEXT_REDIRECT') &&
      digest.includes(pathname)
    );
  };
}

function assertNotFoundElement(element: ReactElement) {
  assert.notEqual(element.type, BookingClient);
  const html = renderToStaticMarkup(element);
  assert.ok(html.includes(t('states.notFound')));
  assert.doesNotMatch(html, /data-booking-page/);
  assert.match(html, /data-logo="wordmark"/);
  assert.ok(html.includes(t('brand.poweredBy')));
  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    assert.equal(href.includes('follow-up'), false, `href ${href}`);
    assert.equal(href.includes('#'), false, `href ${href}`);
  }
  return html;
}

describe('AC-8 host chrome from hostMetaForHostId (BOOK-FE-15)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('(i) `[slug]` IS the owner: /ada/intro-30 renders Ada’s page, never a redirect to /demo', async () => {
    // P1/C1: two owners may both offer `intro-30`, so an owner slug is never
    // canonicalized away to the demo owner. (The rev-1 alias redirect is gone.)
    const element = (await page({ slug: 'ada', event: 'intro-30' })) as ReactElement<{
      slug: string;
      hostSlug: string;
      hostMeta: { firstName: string };
    }>;
    assert.equal(element.type, BookingClient);
    assert.equal(element.props.hostSlug, 'ada');
    assert.equal(element.props.hostMeta.firstName, 'Ada');
    assert.equal(element.props.slug, 'intro-30');
  });

  it('(i-b) an unknown owner is the not-found shell, not somebody else’s page', async () => {
    // In pg mode owners exist only through sign-in materialization; in memory
    // mode a reserved slug is still refused before any store read (REV5-06).
    const reserved = (await page({ slug: 'b', event: 'intro-30' })) as ReactElement;
    assertNotFoundElement(reserved);
  });

  it('(ii) canonical alias renders BookingClient with the canonical host props', async () => {
    ensureDemoFixtures();
    const element = (await page({ slug: 'demo', event: 'intro-30' })) as ReactElement<{
      slug: string;
      hostSlug: string;
      hostMeta: { firstName: string };
      eventMeta: { name: string; durationMinutes: number; kind: string };
    }>;
    assert.equal(element.type, BookingClient);
    assert.equal(element.props.hostMeta.firstName, DEMO_HOST_FIRST_NAME);
    assert.equal(element.props.hostMeta.firstName, 'Marlo');
    assert.equal(element.props.hostSlug, 'demo');
    assert.equal(element.props.slug, 'intro-30');
    assert.equal(element.props.eventMeta.durationMinutes, 30);
    // Plain data props only (BOOK-FE-04).
    for (const value of Object.values(element.props)) {
      assert.notEqual(typeof value, 'function');
    }
  });

  it('(iv) helper table: hostMetaForHostId resolves only the demo host; hostFirstNameForSlug is gone', () => {
    assert.deepEqual(hostMetaForHostId('host-1'), { id: 'host-1', slug: 'demo', firstName: 'Marlo' });
    assert.deepEqual(hostMetaForHostId(DEMO_HOST_ID), { id: 'host-1', slug: 'demo', firstName: 'Marlo' });
    assert.equal(hostMetaForHostId('alice'), null);
    assert.equal(hostMetaForHostId('host-2'), null);
    assert.equal(hostMetaForHostId(''), null);
    assert.equal(typeof (seed as Record<string, unknown>).hostFirstNameForSlug, 'undefined');
  });

  it('(v) source: the page derives no name from URL text and resolves through the catalog', () => {
    const pageSource = readFileSync(path.join(ROOT, 'app/(public)/[slug]/[event]/page.tsx'), 'utf8');
    const seedSource = readFileSync(path.join(ROOT, 'lib/demo/seed.ts'), 'utf8');
    for (const source of [pageSource, seedSource]) {
      assert.doesNotMatch(source, /hostFirstNameForSlug/);
      assert.doesNotMatch(source, /toUpperCase\(/);
    }
    // C1: one owner-scoped resolution, and no demo canonicalization.
    assert.match(pageSource, /resolveScope\(slug, event\)/);
    assert.doesNotMatch(pageSource, /redirect\(/);
    assert.doesNotMatch(pageSource, /hostMetaForHostId/);
    assert.doesNotMatch(pageSource, /getEventTypeBySlug/);
    // The props passed down are the RESOLVED owner's, not the URL segment's.
    assert.match(pageSource, /hostSlug=\{scope\.owner\.slug\}/);
    assert.match(pageSource, /firstName: scope\.owner\.firstName/);
    assert.doesNotMatch(pageSource, /hostSlug=\{slug\}/);
  });

  it('(vi) an event type under a different owner is not served under this one', async () => {
    // `intro-30` exists, but only for `own_other`. Resolution is per owner, so
    // the demo owner's page must not serve it (the old global slug lookup did).
    seedEventType('host-9', 'intro-30', 'own_other');
    let element: ReactElement | undefined;
    await assert.doesNotReject(async () => {
      element = (await page({ slug: 'demo', event: 'intro-30' })) as ReactElement;
    });
    assertNotFoundElement(element!);
  });

  it('unknown event renders states.notFound', async () => {
    ensureDemoFixtures();
    const element = (await page({ slug: 'demo', event: 'nope' })) as ReactElement;
    assertNotFoundElement(element);
  });
});

describe('AC-11 safe public paths on the booking route (BOOK-FE-19)', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
    resetEventTypes();
    resetBookings();
  });

  it('(vii) unrepresentable slug: intro#follow-up resolves to states.notFound — no page, no redirect', async () => {
    seedEventType('host-1', 'intro#follow-up');
    // Precondition this case exists for: the store accepts the slug.
    assert.ok(getEventTypeBySlug('intro#follow-up'));

    let canonical: ReactElement | undefined;
    await assert.doesNotReject(async () => {
      canonical = (await page({ slug: 'demo', event: 'intro#follow-up' })) as ReactElement;
    });
    assertNotFoundElement(canonical!);
  });

  it('a slug the AC-2 validator rejects has no page, however the store stored it', async () => {
    // `café 30` is representable as a *path* but is not a valid slug
    // (`^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$`), so owner-scoped resolution
    // refuses it before any store read rather than serving it.
    seedEventType('host-1', 'café 30');
    assert.ok(getEventTypeBySlug('café 30'));
    const element = (await page({ slug: 'demo', event: 'café 30' })) as ReactElement;
    assertNotFoundElement(element);
  });

  it('(viii) source: page.tsx imports publicBookingPath and interpolates no path', () => {
    const pageSource = readFileSync(path.join(ROOT, 'app/(public)/[slug]/[event]/page.tsx'), 'utf8');
    assert.match(pageSource, /import \{ publicBookingPath \} from '@\/lib\/api\/public-path'/);
    assert.doesNotMatch(pageSource, /`\/\$\{/);
    assert.doesNotMatch(pageSource, /'\/' \+/);
    assert.match(pageSource, /publicBookingPath\(scope\.owner\.slug, scope\.eventType\.slug\)/);
  });
});
