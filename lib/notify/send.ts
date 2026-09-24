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
import { finalize, REQUIRED_RECIPIENTS } from './ledger';

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

  // C5 — validation and claim in ONE host-locked transaction, exactly as
  // notify's N-3 does (REVIEW-06). Validating first and claiming afterwards
  // let a lifecycle change commit in between, so a create worker paused after
  // its T2 could resume past a cancel and acquire **new** `(1, 'confirm')`
  // claims. C5 accepts an *already-claimed* stale send arriving late; it does
  // not accept acquiring a claim for a pair that is already superseded.
  const row = await ctx.store.getById(input.bookingId);
  if (row === null) {
    logMismatch(input);
    return report;
  }
  // `host_id` is immutable, so the unlocked read above is only a lookup.
  let acquired: { recipient: DeliveryRecipient; gen: number }[] | null;
  try {
    acquired = await claimUnderLock(ctx, input, row.hostId, report);
  } catch (error) {
    // The claim transaction did not commit — including the case where it was
    // aborted and `COMMIT` answered `ROLLBACK`. **Nothing** it acquired exists,
    // so nothing may be delivered: every required recipient is unresolved and
    // the next caller re-claims from the durable ledger (REVIEW-01).
    logLifecycle('delivery_claim_failed', {
      bookingId: input.bookingId,
      revision: input.revision,
      action: input.action,
      recipient: 'all',
      detail: detailOf(error),
    });
    return { claimed: [], sent: [], failed: [], unresolved: [...REQUIRED_RECIPIENTS] };
  }

  if (acquired === null) {
    logMismatch(input);
    return report;
  }

  // Only now, with the claim transaction committed, does anything reach Gmail.
  return deliver(ctx, input, acquired, report);
}

/** N-3's validate-and-claim transaction; throws when it does not commit. */
async function claimUnderLock(
  ctx: SendContext,
  input: SendBookingEmailsInput,
  hostId: string,
  report: SendReport,
): Promise<{ recipient: DeliveryRecipient; gen: number }[] | null> {
  return ctx.store.withHostLock(hostId, async (tx) => {
    const locked = await tx.selectForUpdate(input.bookingId);
    if (
      locked === null ||
      locked.revision !== input.revision ||
      locked.latestAction !== input.action
    ) {
      return null;
    }
    const claims: { recipient: DeliveryRecipient; gen: number }[] = [];
    for (const recipient of REQUIRED_RECIPIENTS) {
      // Each claim runs in its own **savepoint** (REVIEW-01). Merely catching
      // the error would leave Postgres with an aborted transaction: the other
      // recipient's claim is still held in memory, `COMMIT` answers `ROLLBACK`
      // and discards its ledger row, and delivering on it would send a copy no
      // `attempts` value ever counted — the exact bound C5 makes exact.
      const attempted = await tx.attempt(() =>
        tx.claimDelivery({
          bookingId: input.bookingId,
          revision: input.revision,
          action: input.action,
          recipient,
          nowMs: ctx.nowMs,
        }),
      );
      if (!attempted.ok) {
        // The business transaction already committed. A ledger failure makes
        // this recipient's delivery *unresolved*, never the booking a failure,
        // and never a reason to skip the other recipient (LIVE-REVIEW-12).
        logLifecycle('delivery_claim_failed', {
          bookingId: input.bookingId,
          revision: input.revision,
          action: input.action,
          recipient,
          detail: detailOf(attempted.error),
        });
        report.unresolved.push(recipient);
        continue;
      }
      if (attempted.value !== null) {
        claims.push({ recipient, gen: attempted.value.gen });
      }
    }
    return claims;
  });
}

function logMismatch(input: SendBookingEmailsInput): void {
  logLifecycle('notify_pair_mismatch', {
    bookingId: input.bookingId,
    revision: input.revision,
    action: input.action,
  });
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Sends claims that were **already acquired** — by notify's N-3, inside the
 * host-locked transaction that validated `(revision, action)` (C5). This half
 * never claims, so nothing can be claimed for a pair a later lifecycle change
 * has already superseded.
 */
export async function deliverClaimed(
  ctx: SendContext,
  input: SendBookingEmailsInput,
  claims: { recipient: DeliveryRecipient; gen: number }[],
): Promise<SendReport> {
  return deliver(ctx, input, claims, {
    claimed: [],
    sent: [],
    failed: [],
    unresolved: [],
  });
}

async function deliver(
  ctx: SendContext,
  input: SendBookingEmailsInput,
  claims: { recipient: DeliveryRecipient; gen: number }[],
  report: SendReport,
): Promise<SendReport> {
  for (const { recipient, gen } of claims) {
    const acquired = { gen };
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
        if (
          await settle(ctx, input, recipient, acquired.gen, 'failed')
        ) {
          report.failed.push(recipient);
        } else {
          report.unresolved.push(recipient);
        }
      } else {
        // Ambiguous: the row stays `claimed` and becomes re-claimable only
        // after the stale window.
        report.unresolved.push(recipient);
      }
      continue;
    }

    if (await settle(ctx, input, recipient, acquired.gen, 'sent')) {
      report.sent.push(recipient);
    } else {
      // Gmail accepted the message and the `sent` write failed: exactly the
      // C5 state that leaves the row `claimed` and re-claimable after the stale
      // window. It is not a failure of the booking, and it must not stop the
      // other recipient's send (LIVE-REVIEW-12).
      report.unresolved.push(recipient);
    }
  }

  return report;
}

/** Finalises one claim, containing a ledger failure as `unresolved`. */
async function settle(
  ctx: SendContext,
  input: SendBookingEmailsInput,
  recipient: DeliveryRecipient,
  gen: number,
  state: 'sent' | 'failed',
): Promise<boolean> {
  try {
    await finalize({
      store: ctx.store,
      bookingId: input.bookingId,
      revision: input.revision,
      action: input.action,
      recipient,
      nowMs: ctx.nowMs,
      gen,
      state,
    });
    return true;
  } catch (error) {
    logLifecycle('delivery_finalize_failed', {
      bookingId: input.bookingId,
      revision: input.revision,
      action: input.action,
      recipient,
      state,
      detail: detailOf(error),
    });
    return false;
  }
}
