// The service layer every route calls. It owns the ORDER the contracts fix:
//
//   1. read-only catalog resolution (C6.9 / REV10-03);
//   2. the C6.9 **kind gate** — 501 in pg/live mode, the existing fixture path
//      in memory mode — before any booking side effect;
//   3. the C2/C9 `Idempotency-Key` check, **after** both of the above, so a
//      resolved `group`/`collective` kind never reaches it (REV15-03);
//   4. the lifecycle itself.

import {
  CALENDAR_INVITATION,
  EMAIL_CONFIRMATION,
  ONE_ON_ONE,
  type EventType,
} from '../availability/event-type';
import type { OneOffMeeting } from '../availability/one-off';
import type { AvailabilitySchedule } from '../availability/schedule';
import {
  assertLiveKind,
  isFixtureOnlyKind,
  memoryCatalogSource,
  pgCatalogSource,
  resolveCatalog,
} from '../catalog';
import { getDatabase, hasDatabase } from '../db/index';
import { assertSingleMailbox } from '../email/address';
import { deliverClaimed, sendBookingEmails } from '../notify/send';
import {
  parseNotifyRequest,
  runNotify,
  type NotifyRequestBody,
  type RecipientClaim,
} from '../notify/route-order';
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
  SlotUnavailableError,
  StaleRevisionError,
} from './errors';
import {
  isOneOffCandidateStart,
  isPublicCandidateStart,
  isRescheduleCandidateStart,
} from '../availability/slots';
import { ensureOwnerFixtures } from './fixtures';
import { DEMO_OWNER_SLUG } from '../owners-materialize';
import { createFingerprint } from './fingerprint';
import { isValidIdempotencyKey } from './ids';
import { acquireStaleOp, type LifecycleContext } from './ops';
import { runRepair } from './repair';
import { hasEligibleReap, reapRetiredIds } from './reap';
import {
  completeInheritedReschedule,
  rescheduleDurableBooking,
  type RescheduleOutcome,
} from './reschedule';
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
    // AC-14: in live mode the adapters are bound to THIS owner's OAuth token.
    calendar: adaptersFor(runtime, owner).calendar,
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

export type CreateEntryResult =
  | { kind: 'durable'; outcome: CreateOutcome }
  | { kind: 'fixture'; response: Response };

/**
 * C2/C6.9 — the shared create entry point. Its whole job is the **order**:
 *
 *   1. read-only catalog resolution and the C6.9 kind gate (`resolveScope`);
 *   2. a resolved memory-mode `group`/`collective` goes to its **existing
 *      fixture handler** here, before anything else;
 *   3. only then the C2/C9 `Idempotency-Key` check and the C6 lifecycle.
 *
 * Step 2 is what the owner-scoped route was missing: it required a key from an
 * exempt fixture request and then ran the exclusive `one_on_one` lifecycle over
 * it (LIVE-REVIEW-10). The handler is injected because it owns the legacy wire
 * shape, and because `lib/booking/booking.ts` imports this module for the C10
 * link create — importing it back would be a cycle.
 */
export async function createBookingEntry(
  input: CreateInput,
  fixtureCreate: (eventType: EventType) => Promise<Response>,
): Promise<CreateEntryResult> {
  const scope = await resolveScope(input.ownerSlug, input.eventSlug);
  if (isFixtureOnlyKind(scope.eventType.kind)) {
    return { kind: 'fixture', response: await fixtureCreate(scope.eventType) };
  }
  return { kind: 'durable', outcome: await createBooking(input, scope) };
}

export async function createBooking(
  input: CreateInput,
  /** Supplied by {@link createBookingEntry} so the catalog is read once. */
  resolved?: ServiceScope,
): Promise<CreateOutcome> {
  const scope = resolved ?? (await resolveScope(input.ownerSlug, input.eventSlug));
  // C6.9 — this path is `one_on_one` only. A fixture kind must have been
  // dispatched by the caller; reaching here would mean applying C9 and the
  // exclusive C6.1 occupancy to a row explicitly outside both contracts.
  assertLiveKind(scope.eventType.kind, true);
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
      // C9 — new submissions only; an existing-key replay stays exempt. The
      // reason is returned, not thrown: T1 fences and answers it (REV8-01).
      gateNewSubmission: () => {
        if (Date.parse(input.start) < scope.runtime.clock.now()) {
          // A start that has already elapsed is not on offer any more.
          return 'slot_unavailable';
        }
        if (
          !isPublicCandidateStart({
            schedule: scope.schedule,
            durationMinutes: scope.eventType.durationMinutes,
            start: input.start,
          })
        ) {
          // Outside the host's schedule, or off the published grid.
          return 'slot_unavailable';
        }
        return null;
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

// ---- create: the legacy one-off link (C10) --------------------------------

export type LinkCreateInput = {
  /** The link token. The C9 key is `link:{token}` — one key per link. */
  token: string;
  eventType: EventType;
  /** Present for an event-type link; a one-off link publishes its own windows. */
  schedule: AvailabilitySchedule | null;
  oneOffMeeting?: OneOffMeeting;
  start: string;
  invitee: { name: string; email: string };
  origin?: string;
  /** Consumes the token inside T2, under the create's own host lock. */
  onFinalize: (row: BookingRow) => void | Promise<void>;
};

/**
 * C10 — a single-use link booking, on the **shared** C6 create path.
 *
 * The link no longer owns a `tokenLocks` boundary or its own calendar ordering:
 * it takes the same per-host lock, the same C6.1 reservation-aware conflict
 * check, and the same two-phase create as the owner-scoped route, so it can
 * neither bypass a reservation held there nor double-book two interleaved link
 * bookings for one host. Its C9 key is `link:{token}`, which is what makes an
 * identical retry after a lost 201 a **replay** of the original booking; a
 * different payload under the same key is `IdempotencyKeyReusedError`, which the
 * route maps to the link contract's 410.
 */
export async function createLinkBooking(
  input: LinkCreateInput,
): Promise<CreateOutcome> {
  const runtime = getRuntime();
  await ensureOwnerFixtures(DEMO_OWNER_SLUG);
  // Links and one-off meetings are demo-owner fixtures (C10): they are never
  // materialized, so the owner is resolved, never created, from the target.
  const owner =
    (await runtime.owners.getById(input.eventType.ownerId)) ??
    (await runtime.owners.getBySlug(DEMO_OWNER_SLUG));
  if (owner === null) {
    throw new EventTypeNotFoundError();
  }
  const schedule: AvailabilitySchedule = input.schedule ?? {
    id: input.eventType.availabilityScheduleId,
    hostId: input.eventType.hostId,
    timezone: input.oneOffMeeting?.timezone ?? 'UTC',
    // A one-off meeting's offer is its own date-scoped windows, checked below.
    windows: [],
  };
  const origin = input.origin ?? '';
  const scope: ServiceScope = {
    runtime,
    owner,
    eventType: input.eventType,
    schedule,
    ctx: contextFor(runtime, owner, input.eventType),
    meta: {
      ownerSlug: owner.slug,
      eventSlug: input.eventType.slug,
      hostFirstName: owner.firstName,
    },
    durable: runtime.env.store === 'pg',
  };

  return createDurableBooking(
    {
      ctx: scope.ctx,
      meta: scope.meta,
      notify: async (row) => {
        await notifyFor(scope, row, 'confirm', origin, null);
      },
      gateNewSubmission: () => {
        if (Date.parse(input.start) < runtime.clock.now()) {
          return 'slot_unavailable';
        }
        const offered =
          input.oneOffMeeting === undefined
            ? isPublicCandidateStart({
                schedule,
                durationMinutes: input.eventType.durationMinutes,
                start: input.start,
              })
            : isOneOffCandidateStart({
                meeting: input.oneOffMeeting,
                start: input.start,
              });
        return offered ? null : 'slot_unavailable';
      },
      onFinalize: input.onFinalize,
    },
    {
      ownerId: owner.id,
      ownerSlug: owner.slug,
      ownerEmail: owner.email,
      hostFirstName: owner.firstName,
      // The **link target's** host, so occupancy is shared with every other
      // booking for that host, whichever route created it.
      hostId: input.eventType.hostId,
      eventTypeId: input.eventType.id,
      eventSlug: input.eventType.slug,
      eventName: input.eventType.name,
      durationMinutes: input.eventType.durationMinutes,
      start: input.start,
      invitee: {
        name: input.invitee.name.trim(),
        email: assertSingleMailbox(input.invitee.email, 'invitee email'),
      },
      notes: null,
      // A one-off's synthetic event type is never in the catalog, so the row
      // describes its own target (C10 — see `oneOffTargetOf`).
      metadata:
        input.oneOffMeeting === undefined
          ? {}
          : {
              [ONE_OFF_METADATA_KEY]: {
                meetingId: input.oneOffMeeting.id,
                name: input.oneOffMeeting.name,
                durationMinutes: input.oneOffMeeting.durationMinutes,
                timezone: input.oneOffMeeting.timezone,
              } satisfies OneOffTarget,
            },
      idempotencyKey: `link:${input.token}`,
      timeZone: schedule.timezone,
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
  // The row stores the event type's **id**, which is the deterministic C1
  // string only for records materialization wrote; resolve it by id rather than
  // deriving a slug from its shape.
  const eventType = await catalogSourceFor(runtime).eventTypeById(row.eventTypeId);
  if (eventType === null) {
    // C10 — a one-off link booking's event type is synthetic and deliberately
    // never registered, so the catalog can never resolve it. The row carries the
    // target's own description instead, which is what makes `/b/{token}` and the
    // authenticated lifecycle routes work for a link-created booking — in a
    // fresh isolate too, where the fixture meeting itself is long gone
    // (LIVE-REVIEW-08).
    const oneOff = oneOffTargetOf(row);
    if (oneOff === null) {
      throw new EventTypeNotFoundError();
    }
    return { ...oneOffScope(runtime, owner, row, oneOff), row };
  }
  const scope = await resolveScope(owner.slug, eventType.slug, runtime);
  return { ...scope, row };
}

/**
 * The self-describing target a C10 one-off link booking persists in
 * `bookings.metadata`. It holds facts, not the fixture's id: a one-off meeting
 * is an in-memory fixture with no durable record (Non-goals), so a later isolate
 * could resolve an id to nothing.
 */
export type OneOffTarget = {
  meetingId: string;
  name: string;
  durationMinutes: number;
  timezone: string;
};

export const ONE_OFF_METADATA_KEY = 'oneOff';

export function oneOffTargetOf(row: BookingRow): OneOffTarget | null {
  const raw = row.metadata[ONE_OFF_METADATA_KEY];
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  if (
    typeof record.meetingId !== 'string' ||
    typeof record.name !== 'string' ||
    typeof record.timezone !== 'string' ||
    typeof record.durationMinutes !== 'number'
  ) {
    return null;
  }
  return {
    meetingId: record.meetingId,
    name: record.name,
    durationMinutes: record.durationMinutes,
    timezone: record.timezone,
  };
}

function oneOffScope(
  runtime: Runtime,
  owner: Owner,
  row: BookingRow,
  target: OneOffTarget,
): ServiceScope {
  const eventType: EventType = {
    id: row.eventTypeId,
    ownerId: owner.id,
    hostId: row.hostId,
    slug: `one-off-${target.meetingId}`,
    name: target.name,
    durationMinutes: target.durationMinutes,
    availabilityScheduleId: target.meetingId,
    kind: ONE_ON_ONE,
    notificationMode: CALENDAR_INVITATION,
  };
  // A one-off publishes date-scoped windows, which a weekly schedule cannot
  // express. Leaving it empty is the honest answer: read and cancel work, and
  // the reschedule picker offers nothing for a booking whose offer was a single
  // spent link — it does not invent a recurring weekly availability.
  const schedule: AvailabilitySchedule = {
    id: target.meetingId,
    hostId: row.hostId,
    timezone: target.timezone,
    windows: [],
  };
  return {
    runtime,
    owner,
    eventType,
    schedule,
    ctx: contextFor(runtime, owner, eventType),
    meta: {
      ownerSlug: owner.slug,
      eventSlug: eventType.slug,
      hostFirstName: owner.firstName,
    },
    durable: runtime.env.store === 'pg',
  };
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
  // C6.6 / C12: `start` must be a candidate of the **reschedule** generator —
  // the same one `GET /api/bookings/{id}/available-times` feeds the picker — so
  // every offered slot is accepted and nothing else is. This runs before R0, so
  // an off-grid or unchanged-time move costs zero calendar calls.
  if (
    !isRescheduleCandidateStart({
      schedule: scope.schedule,
      durationMinutes: scope.eventType.durationMinutes,
      start: input.start,
      excludeStart: scope.row.start,
    })
  ) {
    throw new SlotUnavailableError();
  }
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
        await acquireAndResumeCreate(scope, row, origin);
        return (await scope.runtime.store.getById(row.id)) ?? row;
      },
      repair: {
        eventName: scope.eventType.name,
        invitee: { name: scope.row.inviteeName, email: scope.row.inviteeEmail },
      },
      // N-3 already claimed under the lock; this only delivers those claims.
      send: async (row, action, claims) => {
        await deliverFor(scope, row, action, origin, row.rescheduledFrom, claims);
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
    sendContextFor(scope, origin),
    sendInputFor(scope, row, action, previousStart, origin),
  );
}

/** N-3's half: the claims already exist, so this only delivers and finalises. */
async function deliverFor(
  scope: ServiceScope,
  row: BookingRow,
  action: DeliveryAction,
  origin: string,
  previousStart: string | null,
  claims: RecipientClaim[],
): Promise<void> {
  await deliverClaimed(
    sendContextFor(scope, origin),
    sendInputFor(scope, row, action, previousStart, origin),
    claims,
  );
}

function sendContextFor(scope: ServiceScope, origin: string) {
  const adapters = adaptersFor(scope.runtime, scope.owner);
  return {
    store: scope.runtime.store,
    sender: adapters.sender,
    nowMs: scope.runtime.clock.now(),
    origin,
    // Marlo sends as the host, so the identity is the owner's (AC-14).
    from: adapters.from,
  };
}

/** The owner-bound adapters in live mode; the shared doubles everywhere else. */
function adaptersFor(runtime: Runtime, owner: Owner) {
  return (
    runtime.adaptersFor?.(owner) ?? {
      calendar: runtime.calendar,
      sender: runtime.sender,
      from: runtime.from,
    }
  );
}

function sendInputFor(
  scope: ServiceScope,
  row: BookingRow,
  action: DeliveryAction,
  previousStart: string | null,
  origin: string,
) {
  return {
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
  };
}

/** Completes an inherited create or repair before another op proceeds (C6.4a). */
async function completeInheritedOp(
  scope: ServiceScope,
  row: BookingRow,
  op: PendingOp,
  origin: string,
): Promise<void> {
  if (op.kind === 'create') {
    // The caller already owns `op` (it took it over in its own T1), so this
    // resumes rather than re-acquires.
    await resumeOwnedCreate(scope, row, op, origin);
    return;
  }
  if (op.kind === 'calendar_repair') {
    // The caller already owns `op` — reschedule/cancel T1 took it over and
    // renewed its `startedAt`. Going back through `repairCalendar` would
    // re-acquire it, find the generation it just renewed *not* stale, and
    // answer `operation_in_progress` forever, so the inherited repair could
    // never be completed (REVIEW-01). Resume it under the generation we hold.
    await runRepair(scope.ctx, row, op, {
      eventName: scope.eventType.name,
      invitee: { name: row.inviteeName, email: row.inviteeEmail },
    });
    return;
  }
  if (op.kind === 'reschedule') {
    // C6.7: a taken-over reschedule whose move landed is completed via its own
    // T2 — `revision + 1` and its own `(revision, 'reschedule')` emails — before
    // the taking-over operation continues under that new revision.
    await completeInheritedReschedule(
      {
        ctx: scope.ctx,
        meta: scope.meta,
        notify: async (completed, previousStart) => {
          await notifyFor(scope, completed, 'reschedule', origin, previousStart);
        },
        completeInherited: async () => {},
      },
      row,
      op,
    );
  }
}

/**
 * Resumes a create this caller **already owns** — it took the op over itself
 * (C6.6/C6.7 takeover) and its generation is live. Acquiring it again would bump
 * the generation past the one the caller holds and invalidate its own ownership,
 * so this path never takes over (C6.3).
 */
async function resumeOwnedCreate(
  scope: ServiceScope,
  row: BookingRow,
  op: PendingOp,
  origin: string,
): Promise<void> {
  if (op.kind !== 'create') {
    return;
  }
  await runResumeCreate(scope, row, op, origin);
}

/**
 * N-1's entry point: the caller owns **nothing** yet, so it must acquire the op
 * — and the acquisition decides staleness from the row under the lock, not from
 * the snapshot notify read before it (C6.3). A create is never abandoned, so a
 * `gone`/`busy` acquisition simply leaves it to whoever does own it.
 */
async function acquireAndResumeCreate(
  scope: ServiceScope,
  row: BookingRow,
  origin: string,
): Promise<void> {
  const acquired = await acquireStaleOp(scope.ctx, row, ['create']);
  if (acquired.state !== 'taken') {
    return;
  }
  await runResumeCreate(scope, acquired.row, acquired.op, origin);
}

async function runResumeCreate(
  scope: ServiceScope,
  row: BookingRow,
  op: PendingOp,
  origin: string,
): Promise<void> {
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
  await resumeCreate(deps, request, row, op, {
    opId: op.opId,
    ownerId: row.ownerId,
    idempotencyKey: row.idempotencyKey,
    createFingerprint: row.createFingerprint,
    bookingId: row.id,
  });
}

export {
  createFingerprint,
  intervalOf,
  replayOrResume,
  OperationInProgressError,
  StaleRevisionError,
};
