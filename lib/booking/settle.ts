// C6.5 for the **completing** transactions (T2), not just create T1.
//
// A T2 whose `COMMIT` response is lost is the one case where reading the row is
// not enough: absence of the expected change proves nothing while the original
// transaction may still be in flight. The reconciler therefore reacquires the
// per-host advisory lock on a **fresh connection** — which establishes that the
// original transaction has finished — and only then reads. If the lock cannot
// be reacquired the outcome stays unknown: nothing is compensated, nothing is
// cleared, `pending_op` is retained, and the caller answers 503.

import { UnknownCommitError } from '../db/index';
import { BookingOutcomeUnknownError } from './errors';
import { logLifecycle } from './log';
import type { BookingRow } from './rows';
import { OutcomeUnresolvedError } from './store';
import type { LifecycleContext } from './ops';

export type Settled<T> =
  /** The transaction committed and returned normally. */
  | { kind: 'ok'; value: T }
  /** The response was lost, but reconciliation proved it committed. */
  | { kind: 'reconciled'; row: BookingRow }
  /** Definitely failed, or reconciliation proved a rollback. */
  | { kind: 'failed'; error: unknown };

/**
 * Runs a completing transaction and resolves an unknown commit outcome per
 * C6.5. `didCommit` is evaluated **only** against a row read after the lock was
 * reacquired, so it never interprets a transaction that is still open.
 *
 * Throws {@link BookingOutcomeUnknownError} when the outcome cannot be
 * established — the one answer that leaves the operation owned and retryable.
 */
export async function settleCompletion<T>(
  ctx: LifecycleContext,
  row: BookingRow,
  run: () => Promise<T>,
  didCommit: (fresh: BookingRow | null) => boolean,
): Promise<Settled<T>> {
  let value: T;
  try {
    value = await run();
  } catch (error) {
    if (!(error instanceof UnknownCommitError)) {
      // A definite failure: the caller compensates per its own contract.
      return { kind: 'failed', error };
    }
    let fresh: BookingRow | null;
    try {
      fresh = await ctx.store.withFinishedTransaction(row.hostId, (tx) =>
        tx.selectForUpdate(row.id),
      );
    } catch (reconcileError) {
      if (reconcileError instanceof OutcomeUnresolvedError) {
        logLifecycle('outcome_unresolved', { bookingId: row.id });
        throw new BookingOutcomeUnknownError();
      }
      throw reconcileError;
    }
    if (didCommit(fresh) && fresh !== null) {
      return { kind: 'reconciled', row: fresh };
    }
    // The original transaction is known to have finished without committing:
    // compensation is now safe for callers that owe it.
    return { kind: 'failed', error };
  }
  return { kind: 'ok', value };
}
