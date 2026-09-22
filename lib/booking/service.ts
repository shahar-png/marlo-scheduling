// The service layer every route calls. It owns the ORDER the contracts fix:
//
//   1. read-only catalog resolution (C6.9 / REV10-03);
//   2. the C6.9 **kind gate** — 501 in pg/live mode, the existing fixture path
//      in memory mode — before any booking side effect;
//   3. the C2/C9 `Idempotency-Key` check, **after** both of the above, so a
//      resolved `group`/`collective` kind never reaches it (REV15-03);
//   4. the lifecycle itself.

import { EMAIL_CONFIRMATION, type EventType } from '../availability/event-type';
import type { AvailabilitySchedule } from '../availability/schedule';
import {
  assertLiveKind,
  memoryCatalogSource,
  pgCatalogSource,
  resolveCatalog,
} from '../catalog';
import { getDatabase, hasDatabase } from '../db/index';
import { assertSingleMailbox } from '../email/address';
import { sendBookingEmails } from '../notify/send';
import { parseNotifyRequest, runNotify, type NotifyRequestBody } from '../notify/route-order';
import type { Owner } from '../owners';
import { durableAvailableTimes } from './availability';
import { cancelDurableBooking, type CancelOutcome } from './cancel';
import {
  createDurableBooking,
  intervalOf,
  replayOrResume,
  resumeCreate,
  type CreateOutcome,
} from './create';
import { buildEnvelope, type BookingEnvelope, type EnvelopeMeta } from './envelope';
import {
  EventTypeNotFoundError,
  IdempotencyKeyRequiredError,
  OperationInProgressError,
  StaleRevisionError,
} from './errors';
import { createFingerprint } from './fingerprint';
import { isValidIdempotencyKey } from './ids';
import { takeOverOp, type LifecycleContext } from './ops';
import { repairCalendar } from './repair';
import { hasEligibleReap, reapRetiredIds } from './reap';
import { rescheduleDurableBooking, type RescheduleOutcome } from './reschedule';
import { type BookingRow, type Interval, type PendingOp } from './rows';
import { getRuntime, type Runtime } from './runtime';
import type { DeliveryAction } from './store';

export type ServiceScope = {
  runtime: Runtime;
  owner: Owner;
  eventType: EventType;
  schedule: AvailabilitySchedule;
  ctx: LifecycleContext;
  meta: EnvelopeMeta;
  /** True when the durable store is in use (pg mode). */
  durable: boolean;
};

export async function resolveScope(
  ownerSlug: string,
  eventSlug: string,
  runtime: Runtime = getRuntime(),
): Promise<ServiceScope> {
  const resolved = await resolveCatalog(
    catalogSourceFor(runtime),
    ownerSlug,
    eventSlug,
  );
  // (2) the kind gate, immediately after resolution and before any side effect.
  assertLiveKind(resolved.eventType.kind, runtime.env.store === 'pg');
  if (resolved.schedule === null) {
    throw new EventTypeNotFoundError();
  }
  return {
    runtime,
    owner: resolved.owner,
    eventType: resolved.eventType,
    schedule: resolved.schedule,
    ctx: contextFor(runtime, resolved.owner, resolved.eventType),
    meta: {
      ownerSlug: resolved.owner.slug,
      eventSlug: resolved.eventType.slug,
      hostFirstName: resolved.owner.firstName,
    },
    durable: runtime.env.store === 'pg',
  };
}

function catalogSourceFor(runtime: Runtime) {
  // In pg mode the catalog is read from Postgres (the statement log AC-24
  // asserts); in memory mode it is the fixture registry.
  return runtime.env.store === 'pg' && hasDatabase()
    ? pgCatalogSource(getDatabase(), runtime.owners)
    : memoryCatalogSource(runtime.owners);
}

export function contextFor(
  runtime: Runtime,
  owner: Owner,
  eventType: Pick<EventType, 'notificationMode'>,
): LifecycleContext {
  return {
    store: runtime.store,
    calendar: runtime.calendar,
    calendarId: owner.calendarId,
    clock: runtime.clock,
    // C4: `notificationMode` selects ONLY Google's attendee behaviour.
    // Calendar occupancy and Marlo's own emails are unconditional.
    sendUpdates: eventType.notificationMode === EMAIL_CONFIRMATION ? 'none' : 'all',
  };
}

// ---- create ---------------------------------------------------------------

export type CreateInput = {
  ownerSlug: string;
  eventSlug: string;
  start: string;
  invitee: { name: string; email: string };
  notes: string | null;
  idempotencyKey: string | null;
  origin: string;
  metadata?: Record<string, unknown>;
};

export async function createBooking(input: CreateInput): Promise<CreateOutcome> {
  const scope = await resolveScope(input.ownerSlug, input.eventSlug);
  // (3) the header check runs only after resolution and the kind gate.
  const key = requireIdempotencyKey(input.idempotencyKey);
  const inviteeEmail = assertSingleMailbox(input.invitee.email, 'invitee email');

  return createDurableBooking(
    {
      ctx: scope.ctx,
      meta: scope.meta,
      notify: async (row) => {
        await notifyFor(scope, row, 'confirm', input.origin, null);
      },
    },
    {
      ownerId: scope.owner.id,
      ownerSlug: scope.owner.slug,
      ownerEmail: scope.owner.email,
      hostFirstName: scope.owner.firstName,
      hostId: scope.eventType.hostId,
      eventTypeId: scope.eventType.id,
      eventSlug: scope.eventType.slug,
      eventName: scope.eventType.name,
      durationMinutes: scope.eventType.durationMinutes,
      start: input.start,
      invitee: { name: input.invitee.name.trim(), email: inviteeEmail },
      notes: input.notes,
      metadata: input.metadata ?? {},
      idempotencyKey: key,
      timeZone: scope.schedule.timezone,
    },
  );
}

export function requireIdempotencyKey(key: string | null): string {
  if (key === null || !isValidIdempotencyKey(key)) {
    throw new IdempotencyKeyRequiredError();
  }
  return key.trim();
}

// ---- availability ---------------------------------------------------------

export async function availableTimes(input: {
  ownerSlug: string;
  eventSlug: string;
  window: Interval;
}): Promise<{ times: string[]; scope: ServiceScope }> {
  const scope = await resolveScope(input.ownerSlug, input.eventSlug);
  const times = await durableAvailableTimes(scope.ctx, {
    eventType: scope.eventType,
    schedule: scope.schedule,
    window: input.window,
  });
  return { times, scope };
}

// ---- token-authenticated surfaces ----------------------------------------

export type BookingScope = ServiceScope & { row: BookingRow };

/**
 * Resolves the scope for an existing row. `/b/{token}` and every
 * `/api/bookings/{id}/*` route go through here, so the C6.9 defensive branch
 * and the envelope meta are shared.
 */
export async function scopeForRow(
  row: BookingRow,
  runtime: Runtime = getRuntime(),
): Promise<BookingScope> {
  const owner = await runtime.owners.getById(row.ownerId);
  if (owner === null) {
    throw new EventTypeNotFoundError();
  }
  const scope = await resolveScope(owner.slug, eventSlugOf(row), runtime);
  return { ...scope, row };
}

function eventSlugOf(row: BookingRow): string {
  // The C1 id is `evt_{ownerSlug}__{eventSlug}`.
  const marker = row.eventTypeId.indexOf('__');
  return marker === -1 ? row.eventTypeId : row.eventTypeId.slice(marker + 2);
}

export async function readBooking(
  scope: BookingScope,
): Promise<BookingEnvelope> {
  // A read is one of the designated observing calls for the C6.3a reap.
  if (hasEligibleReap(scope.row)) {
    await reapRetiredIds(scope.ctx, scope.row.id);
  }
  const fresh = (await scope.runtime.store.getById(scope.row.id)) ?? scope.row;
  return buildEnvelope(scope.runtime.store, fresh, scope.meta, 'read');
}

export async function bookingAvailability(
  scope: BookingScope,
  window: Interval,
): Promise<string[]> {
  const times = await durableAvailableTimes(scope.ctx, {
    eventType: scope.eventType,
    schedule: scope.schedule,
    window,
    excludeBookingId: scope.row.id,
    reschedule: true,
  });
  // The booking's current start is never offered (an unchanged-time move).
  return times.filter((start) => start !== scope.row.start);
}

export async function rescheduleBooking(
  scope: BookingScope,
  input: { start: string; expectedRevision: number; origin: string },
): Promise<RescheduleOutcome> {
  return rescheduleDurableBooking(
    {
      ctx: scope.ctx,
      meta: scope.meta,
      notify: async (row, previousStart) => {
        await notifyFor(scope, row, 'reschedule', input.origin, previousStart);
      },
      completeInherited: async (row, op) => {
        await completeInheritedOp(scope, row, op, input.origin);
      },
    },
    {
      bookingId: scope.row.id,
      start: input.start,
      expectedRevision: input.expectedRevision,
      durationMinutes: scope.eventType.durationMinutes,
      eventName: scope.eventType.name,
      invitee: { name: scope.row.inviteeName, email: scope.row.inviteeEmail },
      timeZone: scope.schedule.timezone,
    },
  );
}

export async function cancelBooking(
  scope: BookingScope,
  input: { expectedRevision: number; origin: string },
): Promise<CancelOutcome> {
  return cancelDurableBooking(
    {
      ctx: scope.ctx,
      meta: scope.meta,
      notify: async (row) => {
        await notifyFor(scope, row, 'cancel', input.origin, null);
      },
      completeInherited: async (row, op) => {
        await completeInheritedOp(scope, row, op, input.origin);
      },
    },
    { bookingId: scope.row.id, expectedRevision: input.expectedRevision },
  );
}

export type NotifyOutcome = {
  envelope: BookingEnvelope;
  retried: { revision: number; action: DeliveryAction } | null;
};

export async function notifyBooking(
  scope: BookingScope,
  body: NotifyRequestBody,
  origin: string,
): Promise<NotifyOutcome> {
  const request = parseNotifyRequest(body);
  const result = await runNotify(
    {
      ctx: scope.ctx,
      resumeCreate: async (row) => {
        await completeInheritedCreate(scope, row, origin);
        return (await scope.runtime.store.getById(row.id)) ?? row;
      },
      repair: {
        eventName: scope.eventType.name,
        invitee: { name: scope.row.inviteeName, email: scope.row.inviteeEmail },
      },
      send: async (row, action) => {
        await notifyFor(scope, row, action, origin, row.rescheduledFrom);
      },
    },
    scope.row.id,
    request,
  );
  return {
    envelope: await buildEnvelope(scope.runtime.store, result.row, scope.meta, 'lifecycle'),
    retried: result.retried,
  };
}

// ---- shared helpers -------------------------------------------------------

async function notifyFor(
  scope: ServiceScope,
  row: BookingRow,
  action: DeliveryAction,
  origin: string,
  previousStart: string | null,
): Promise<void> {
  await sendBookingEmails(
    {
      store: scope.runtime.store,
      sender: scope.runtime.sender,
      nowMs: scope.runtime.clock.now(),
      origin,
      from: scope.runtime.from,
    },
    {
      bookingId: row.id,
      revision: row.revision,
      action,
      template: {
        hostFirstName: scope.owner.firstName,
        ownerEmail: scope.owner.email,
        inviteeName: row.inviteeName,
        inviteeEmail: row.inviteeEmail,
        eventName: scope.eventType.name,
        start: row.start,
        end: row.end,
        ...(previousStart === null ? {} : { previousStart }),
        token: row.token,
        origin,
        bookingId: row.id,
        revision: row.revision,
      },
    },
  );
}

/** Completes an inherited create or repair before another op proceeds (C6.4a). */
async function completeInheritedOp(
  scope: ServiceScope,
  row: BookingRow,
  op: PendingOp,
  origin: string,
): Promise<void> {
  if (op.kind === 'create') {
    await completeInheritedCreate(scope, row, origin, op);
    return;
  }
  if (op.kind === 'calendar_repair') {
    await repairCalendar(scope.ctx, row, {
      eventName: scope.eventType.name,
      invitee: { name: row.inviteeName, email: row.inviteeEmail },
    });
  }
}

async function completeInheritedCreate(
  scope: ServiceScope,
  row: BookingRow,
  origin: string,
  op?: PendingOp,
): Promise<void> {
  const target = op ?? row.pendingOp;
  if (target === null || target === undefined || target.kind !== 'create') {
    return;
  }
  const request = {
    ownerId: scope.owner.id,
    ownerSlug: scope.owner.slug,
    ownerEmail: scope.owner.email,
    hostFirstName: scope.owner.firstName,
    hostId: row.hostId,
    eventTypeId: row.eventTypeId,
    eventSlug: scope.eventType.slug,
    eventName: scope.eventType.name,
    durationMinutes: scope.eventType.durationMinutes,
    start: row.start,
    invitee: { name: row.inviteeName, email: row.inviteeEmail },
    notes: row.notes,
    metadata: row.metadata,
    idempotencyKey: row.idempotencyKey,
    timeZone: scope.schedule.timezone,
  };
  const deps = {
    ctx: scope.ctx,
    meta: scope.meta,
    notify: async (completed: BookingRow) => {
      // The create's own T2/T2′ issues the `(revision, 'confirm')` claim — that
      // claim belongs to the create, never to the caller that resumed it.
      await notifyFor(scope, completed, 'confirm', origin, null);
    },
  };
  // A create is never abandoned: take it over (C6.3) and complete it.
  const taken = await scope.runtime.store.withHostLock(row.hostId, async (tx) => {
    const fresh = await tx.selectForUpdate(row.id);
    if (fresh === null || fresh.pendingOp === null || fresh.pendingOp.kind !== 'create') {
      return null;
    }
    return takeOverOp(tx, fresh, fresh.pendingOp, scope.ctx.clock);
  });
  if (taken === null) {
    return;
  }
  const fresh = (await scope.runtime.store.getById(row.id)) ?? row;
  await resumeCreate(deps, request, fresh, taken, {
    opId: taken.opId,
    ownerId: fresh.ownerId,
    idempotencyKey: fresh.idempotencyKey,
    createFingerprint: fresh.createFingerprint,
    bookingId: fresh.id,
  });
}

export {
  createFingerprint,
  intervalOf,
  replayOrResume,
  OperationInProgressError,
  StaleRevisionError,
};
