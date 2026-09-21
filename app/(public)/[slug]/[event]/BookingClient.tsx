'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Logo } from '@/app/components/Logo';
import { createBooking, getSlots } from '@/lib/api/client';
import type { BookingApi } from '@/lib/api/types';
import { t } from '@/lib/copy';
import {
  BookingForm,
  type BookingEventMeta,
  type BookingHostMeta,
} from './BookingForm';
import type { Scheduler } from './booking-form-store';

// Client wrapper (BOOK-FE-04): the production dependencies — api helpers that
// fetch the existing /api/... routes, router navigation, the clock, the
// interval scheduler, and the displayed time zone — are created here, inside
// the client bundle, and passed client→client into BookingForm. The Server
// page only sends plain data and no initial month (BOOK-FE-09).

export type BookingClientProps = {
  slug: string;
  hostSlug: string;
  eventMeta: BookingEventMeta;
  hostMeta: BookingHostMeta;
};

const api: BookingApi = { getSlots, createBooking };

const schedule: Scheduler = {
  setInterval: (callback, ms) => window.setInterval(callback, ms),
  clearInterval: (handle) => window.clearInterval(handle as number),
};

const now = () => new Date();

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function BookingClient(props: BookingClientProps) {
  const router = useRouter();
  const navigate = useMemo(
    () => (href: string) => {
      router.push(href);
    },
    [router],
  );
  // The zone differs between the server render (UTC) and the browser, and
  // the month title / day groups depend on it. Resolve it after mount and
  // render the picker only once it is known — no hydration mismatch and no
  // first render in the wrong month.
  const [timeZone, setTimeZone] = useState<string | null>(null);
  useEffect(() => {
    setTimeZone(resolveTimeZone());
  }, []);

  if (timeZone === null) {
    return (
      <main className="marlo-page">
        <header className="marlo-header">
          <Logo variant="wordmark" height={25} />
        </header>
        <section className="marlo-card" style={{ gridTemplateColumns: '1fr' }}>
          <p className="marlo-muted" aria-busy="true">
            {t('booking.loadingSlots')}
          </p>
        </section>
      </main>
    );
  }

  return (
    <BookingForm
      slug={props.slug}
      hostSlug={props.hostSlug}
      eventMeta={props.eventMeta}
      hostMeta={props.hostMeta}
      timeZone={timeZone}
      api={api}
      navigate={navigate}
      now={now}
      schedule={schedule}
    />
  );
}
