// C4 — the six bodies: confirm / reschedule / cancel × invitee / owner.
//
// Recipients are a **product constant**, not a mode (P3): every action emails
// both the invitee and the owner. `notificationMode` selects only Google's
// attendee behaviour, never who Marlo writes to.
//
// Every body carries the absolute `/b/{token}` URL and one sentence saying the
// booking page is authoritative (REV6-05) — the README's authoritative-status
// pointer must be reachable from the very email that prompted it.

import { buildIcs } from './ics';

export type EmailAction = 'confirm' | 'reschedule' | 'cancel';
export type EmailRecipient = 'invitee' | 'owner';

export const BOOKING_PAGE_SENTENCE =
  'The booking page always shows the current status of this booking.';

/** Built from the issuing request's origin — notify retries are requests too. */
export function bookingPageUrl(origin: string, token: string): string {
  const base = origin.replace(/\/+$/, '');
  return `${base}/b/${encodeURIComponent(token)}`;
}

export type TemplateInput = {
  action: EmailAction;
  recipient: EmailRecipient;
  hostFirstName: string;
  ownerEmail: string;
  inviteeName: string;
  inviteeEmail: string;
  eventName: string;
  start: string;
  end: string;
  /** Set on a reschedule so the body can carry old and new times. */
  previousStart?: string;
  token: string;
  origin: string;
  bookingId: string;
  revision: number;
};

export type RenderedEmail = {
  to: string;
  subject: string;
  body: string;
  ics: { filename: string; content: string };
};

/** Cancel copy is its own constant, disjoint from the confirmation intro. */
const CONFIRM_INTRO_INVITEE = 'Your meeting is confirmed.';
const CONFIRM_INTRO_OWNER = 'You have a new booking.';
const RESCHEDULE_INTRO_INVITEE = 'Your meeting has been moved.';
const RESCHEDULE_INTRO_OWNER = 'A booking has been moved.';
const CANCEL_INTRO_INVITEE = 'Your meeting has been cancelled.';
const CANCEL_INTRO_OWNER = 'A booking has been cancelled.';

export function formatWhen(iso: string): string {
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

export function emailSubject(input: TemplateInput): string {
  const host = input.hostFirstName;
  if (input.recipient === 'invitee') {
    if (input.action === 'confirm') {
      return `Confirmed: ${input.eventName} with ${host}`;
    }
    if (input.action === 'reschedule') {
      return `Moved: ${input.eventName} with ${host}`;
    }
    return `Cancelled: ${input.eventName} with ${host}`;
  }
  if (input.action === 'confirm') {
    return `New booking: ${input.inviteeName} — ${input.eventName}`;
  }
  if (input.action === 'reschedule') {
    return `Moved: ${input.inviteeName} — ${input.eventName}`;
  }
  return `Cancelled: ${input.inviteeName} — ${input.eventName}`;
}

function intro(input: TemplateInput): string {
  if (input.recipient === 'invitee') {
    if (input.action === 'confirm') return CONFIRM_INTRO_INVITEE;
    if (input.action === 'reschedule') return RESCHEDULE_INTRO_INVITEE;
    return CANCEL_INTRO_INVITEE;
  }
  if (input.action === 'confirm') return CONFIRM_INTRO_OWNER;
  if (input.action === 'reschedule') return RESCHEDULE_INTRO_OWNER;
  return CANCEL_INTRO_OWNER;
}

export function renderEmail(input: TemplateInput): RenderedEmail {
  const url = bookingPageUrl(input.origin, input.token);
  const lines: string[] = [intro(input), ''];

  if (input.recipient === 'invitee') {
    lines.push(`With: ${input.hostFirstName}`);
  } else {
    // The owner's copy says who booked.
    lines.push(`Booked by: ${input.inviteeName} <${input.inviteeEmail}>`);
  }
  lines.push(`What: ${input.eventName}`);

  if (input.action === 'reschedule' && input.previousStart !== undefined) {
    lines.push(`Previous time: ${formatWhen(input.previousStart)}`);
    lines.push(`New time: ${formatWhen(input.start)}`);
  } else {
    lines.push(`When: ${formatWhen(input.start)}`);
  }

  lines.push('');
  lines.push(`Booking page: ${url}`);
  lines.push(BOOKING_PAGE_SENTENCE);

  const ics = buildIcs({
    uid: `${input.bookingId}@marlo`,
    start: input.start,
    end: input.end,
    summary: `${input.eventName} with ${input.hostFirstName}`,
    description: `Booking page: ${url}`,
    organizerEmail: input.ownerEmail,
    attendeeEmail: input.inviteeEmail,
    status: input.action === 'cancel' ? 'CANCELLED' : 'CONFIRMED',
    sequence: input.revision,
    stamp: input.start,
  });

  return {
    to: input.recipient === 'invitee' ? input.inviteeEmail : input.ownerEmail,
    subject: emailSubject(input),
    body: lines.join('\n'),
    ics: { filename: 'invite.ics', content: ics },
  };
}

export const CANCEL_INTROS = [CANCEL_INTRO_INVITEE, CANCEL_INTRO_OWNER] as const;
export const CONFIRM_INTROS = [CONFIRM_INTRO_INVITEE, CONFIRM_INTRO_OWNER] as const;
