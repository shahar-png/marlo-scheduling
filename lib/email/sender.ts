// The Gmail send port. `GmailSendError.definite` is the whole C5 finalisation
// rule in one flag: a **definite** refusal (a non-2xx that proves the message
// was not accepted — 4xx other than 429, or `host_not_connected`) finalises the
// ledger row `failed`; anything **ambiguous** (timeout, 5xx, 429, network,
// process death) leaves it `claimed`, because Gmail may have accepted it.

import { assertSingleMailbox } from './address';
import { buildMimeMessage, toGmailRaw } from './mime';
import { classifyGmailError, DEFINITE, HostNotConnectedError } from '../google/errors';
import type { FetchLike } from '../google/live-calendar';
import type { EmailAction, EmailRecipient } from './templates';

const GMAIL_SEND = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export type OutboundEmail = {
  to: string;
  toDisplayName?: string;
  from: string;
  subject: string;
  body: string;
  ics: { filename: string; content: string };
  /** Recorded by the mock sender for the AC-13 assertions. */
  action: EmailAction;
  recipient: EmailRecipient;
  revision: number;
  bookingId: string;
};

export class GmailSendError extends Error {
  constructor(
    message: string,
    readonly definite: boolean,
  ) {
    super(message);
    this.name = 'GmailSendError';
  }
}

export interface BookingEmailSender {
  send(email: OutboundEmail): Promise<void>;
}

export type SentRecord = {
  action: EmailAction;
  recipient: EmailRecipient;
  revision: number;
  to: string;
  subject: string;
  body: string;
  bookingId: string;
};

export type MockEmailSender = BookingEmailSender & {
  readonly sent: SentRecord[];
  /** Queue one outcome for the next send: definite refusal or ambiguous. */
  failNext(outcome: { definite: boolean; message?: string }): void;
  failAlways(outcome: { definite: boolean; message?: string } | null): void;
  reset(): void;
};

export function createMockEmailSender(): MockEmailSender {
  const sent: SentRecord[] = [];
  const queued: { definite: boolean; message?: string }[] = [];
  let always: { definite: boolean; message?: string } | null = null;

  return {
    sent,
    failNext(outcome) {
      queued.push(outcome);
    },
    failAlways(outcome) {
      always = outcome;
    },
    reset() {
      sent.length = 0;
      queued.length = 0;
      always = null;
    },
    async send(email: OutboundEmail): Promise<void> {
      const failure = queued.shift() ?? always;
      if (failure) {
        // Recorded as an *attempt* even when refused, so AC-13(l) can count
        // refused attempts separately from delivered copies.
        throw new GmailSendError(failure.message ?? 'mock_gmail_failure', failure.definite);
      }
      sent.push({
        action: email.action,
        recipient: email.recipient,
        revision: email.revision,
        to: email.to,
        subject: email.subject,
        body: email.body,
        bookingId: email.bookingId,
      });
    },
  };
}

export type LiveEmailSenderOptions = {
  fetch: FetchLike;
  accessToken: () => Promise<string>;
};

export function createLiveEmailSender(options: LiveEmailSenderOptions): BookingEmailSender {
  return {
    async send(email: OutboundEmail): Promise<void> {
      assertSingleMailbox(email.to, 'recipient');
      let token: string;
      try {
        token = await options.accessToken();
      } catch (error) {
        if (error instanceof HostNotConnectedError) {
          // Definite: nothing was sent.
          throw new GmailSendError('host_not_connected', true);
        }
        throw new GmailSendError(messageOf(error), false);
      }
      const raw = toGmailRaw(
        buildMimeMessage({
          from: email.from,
          to: email.to,
          ...(email.toDisplayName === undefined
            ? {}
            : { toDisplayName: email.toDisplayName }),
          subject: email.subject,
          body: email.body,
          ics: email.ics,
        }),
      );
      let status: number;
      try {
        const response = await options.fetch(GMAIL_SEND, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ raw }),
        });
        status = response.status;
      } catch (error) {
        // Network error / timeout: ambiguous — Gmail may have accepted it.
        throw new GmailSendError(messageOf(error), false);
      }
      const klass = classifyGmailError(status);
      if (klass === 'applied') {
        return;
      }
      throw new GmailSendError(`gmail_send_failed_${status}`, klass === DEFINITE);
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
