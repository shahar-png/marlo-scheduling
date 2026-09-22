// C5 send path. For the current `(revision, action)` it claims **every
// required recipient** — so a recipient that was never claimed (the lifecycle
// T2 committed and the process died before it) is sent exactly once, and a
// recipient already `sent` is never re-sent (REV4-05).
//
// No pre-send revision re-check and no send deadline are performed: neither
// could close the window an already-claimed send leaves open (REV5-05,
// REV6-04), so this file does not pretend to. Serialising issuance with
// lifecycle changes is a Non-goal.

import { logLifecycle } from '../booking/log';
import type { BookingStore, DeliveryAction, DeliveryRecipient } from '../booking/store';
import { GmailSendError, type BookingEmailSender } from '../email/sender';
import { renderEmail, type TemplateInput } from '../email/templates';
import { claim, finalize, REQUIRED_RECIPIENTS } from './ledger';

export type SendContext = {
  store: BookingStore;
  sender: BookingEmailSender;
  nowMs: number;
  /** Absolute origin of the issuing request — notify retries are requests too. */
  origin: string;
  from: string;
};

export type SendBookingEmailsInput = {
  bookingId: string;
  revision: number;
  action: DeliveryAction;
  template: Omit<TemplateInput, 'action' | 'recipient'>;
};

export type SendReport = {
  claimed: DeliveryRecipient[];
  sent: DeliveryRecipient[];
  failed: DeliveryRecipient[];
  /** Ambiguous outcomes: the row stays `claimed` (C5 finalisation rule). */
  unresolved: DeliveryRecipient[];
};

export async function sendBookingEmails(
  ctx: SendContext,
  input: SendBookingEmailsInput,
): Promise<SendReport> {
  const report: SendReport = { claimed: [], sent: [], failed: [], unresolved: [] };

  for (const recipient of REQUIRED_RECIPIENTS) {
    const acquired = await claim({
      store: ctx.store,
      bookingId: input.bookingId,
      revision: input.revision,
      action: input.action,
      recipient,
      nowMs: ctx.nowMs,
    });
    if (acquired === null) {
      // `sent`, or a fresh `claimed` row: this caller does not send.
      continue;
    }
    report.claimed.push(recipient);

    const rendered = renderEmail({
      ...input.template,
      action: input.action,
      recipient,
    });

    try {
      await ctx.sender.send({
        to: rendered.to,
        from: ctx.from,
        subject: rendered.subject,
        body: rendered.body,
        ics: rendered.ics,
        action: input.action,
        recipient,
        revision: input.revision,
        bookingId: input.bookingId,
      });
    } catch (error) {
      const definite = error instanceof GmailSendError ? error.definite : false;
      logLifecycle('gmail_send_failed', {
        bookingId: input.bookingId,
        revision: input.revision,
        action: input.action,
        recipient,
        definite,
      });
      if (definite) {
        // Only a definite refusal writes `failed` — it delivered nothing, so
        // the row is re-claimable immediately and `attempts` stays an exact
        // bound on copies (REV7-04).
        await finalize({
          store: ctx.store,
          bookingId: input.bookingId,
          revision: input.revision,
          action: input.action,
          recipient,
          nowMs: ctx.nowMs,
          gen: acquired.gen,
          state: 'failed',
        });
        report.failed.push(recipient);
      } else {
        // Ambiguous: the row stays `claimed` and becomes re-claimable only
        // after the stale window.
        report.unresolved.push(recipient);
      }
      continue;
    }

    await finalize({
      store: ctx.store,
      bookingId: input.bookingId,
      revision: input.revision,
      action: input.action,
      recipient,
      nowMs: ctx.nowMs,
      gen: acquired.gen,
      state: 'sent',
    });
    report.sent.push(recipient);
  }

  return report;
}
