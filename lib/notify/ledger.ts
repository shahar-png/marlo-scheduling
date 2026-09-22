// C5 — the delivery ledger.
//
// One row per `(booking, revision, action, recipient)`. Initial delivery and
// every retry share one **atomic claim**, and the `attempts` value the claim
// returns is the **claim generation**: every finalisation carries it, so a late
// finaliser whose claim was taken over after the stale window updates zero rows
// and can never flip the new owner's row (REV2-06).
//
// Two re-claim conditions with two different bounds (REV7-04):
//   * `failed` — **no age condition**, re-claimable immediately, because
//     `failed` is written only for a *definite* refusal that delivered nothing;
//   * `claimed` — only after the 2-minute stale window, because Gmail may have
//     accepted the message.
//
// What `attempts` bounds is the number of **copies**; what it does not bound is
// *when* each copy is delivered — a worker that claimed and stalled sends its
// copy whenever it resumes, so delayed copies can cluster (REV6-04).

import { logLifecycle } from '../booking/log';
import type {
  BookingStore,
  DeliveryAction,
  DeliveryRecipient,
  DeliveryRow,
} from '../booking/store';

export const REQUIRED_RECIPIENTS: readonly DeliveryRecipient[] = ['invitee', 'owner'];

export type DeliverySummary = 'sent' | 'failed' | 'pending';

/**
 * REV4-05 — computed against the **required recipient set**, not against
 * whatever rows happen to exist: `sent` iff a row exists for BOTH recipients
 * and both are `sent`; `failed` if any existing row is `failed`; otherwise
 * `pending`, which includes a recipient with no row at all.
 */
export function summarizeDelivery(
  rows: DeliveryRow[],
  required: readonly DeliveryRecipient[] = REQUIRED_RECIPIENTS,
): DeliverySummary {
  if (rows.some((row) => row.state === 'failed')) {
    return 'failed';
  }
  const sent = new Set(
    rows.filter((row) => row.state === 'sent').map((row) => row.recipient),
  );
  return required.every((recipient) => sent.has(recipient)) ? 'sent' : 'pending';
}

export type ClaimInput = {
  store: BookingStore;
  bookingId: string;
  revision: number;
  action: DeliveryAction;
  recipient: DeliveryRecipient;
  nowMs: number;
};

export type Claim = { gen: number };

export async function claim(input: ClaimInput): Promise<Claim | null> {
  return input.store.claimDelivery({
    bookingId: input.bookingId,
    revision: input.revision,
    action: input.action,
    recipient: input.recipient,
    nowMs: input.nowMs,
  });
}

export type FinalizeInput = ClaimInput & {
  gen: number;
  state: 'sent' | 'failed';
};

/** Generation-conditioned; there is no finalisation path without a `gen`. */
export async function finalize(input: FinalizeInput): Promise<boolean> {
  const updated = await input.store.finalizeDelivery({
    bookingId: input.bookingId,
    revision: input.revision,
    action: input.action,
    recipient: input.recipient,
    gen: input.gen,
    state: input.state,
  });
  if (!updated) {
    logLifecycle('stale_finalize_ignored', {
      bookingId: input.bookingId,
      revision: input.revision,
      action: input.action,
      recipient: input.recipient,
      gen: input.gen,
    });
  }
  return updated;
}

export async function deliverySummaryFor(
  store: BookingStore,
  bookingId: string,
  revision: number,
  action: DeliveryAction | null,
): Promise<DeliverySummary> {
  if (action === null) {
    // No notifiable pair yet (the create's T2/T2′ has not run): every required
    // recipient is missing, so the summary is `pending` (C5 / C3).
    return 'pending';
  }
  const rows = await store.deliveryRows(bookingId, revision, action);
  return summarizeDelivery(rows);
}
