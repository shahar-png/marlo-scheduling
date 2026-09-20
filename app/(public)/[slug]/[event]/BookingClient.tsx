'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { createBooking, getSlots } from '@/lib/api/client';
import type { BookingApi } from '@/lib/api/types';
import {
  BookingForm,
  type BookingEventMeta,
  type BookingHostMeta,
} from './BookingForm';
import type { Scheduler } from './booking-form-store';

// Client wrapper (BOOK-FE-04): the production dependencies — api helpers that
// fetch the existing /api/... routes, router navigation, the clock, and the
// interval scheduler — are created here, inside the client bundle, and passed
// client→client into BookingForm. The Server page only sends plain data.

export type BookingClientProps = {
  slug: string;
  hostSlug: string;
  eventMeta: BookingEventMeta;
  hostMeta: BookingHostMeta;
  initialMonth: string;
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
  // Resolve the invitee's zone after mount so the server-rendered shell and
  // the first client render agree (no hydration mismatch on the header).
  const [timeZone, setTimeZone] = useState('UTC');
  useEffect(() => {
    setTimeZone(resolveTimeZone());
  }, []);

  return (
    <BookingForm
      slug={props.slug}
      hostSlug={props.hostSlug}
      eventMeta={props.eventMeta}
      hostMeta={props.hostMeta}
      initialMonth={props.initialMonth}
      timeZone={timeZone}
      api={api}
      navigate={navigate}
      now={now}
      schedule={schedule}
    />
  );
}
