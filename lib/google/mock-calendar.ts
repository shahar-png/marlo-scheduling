// In-memory Google Calendar model — the memory-mode adapter AND the test
// double the pg/live scenarios run against (AC-12 parity matrix).
//
// It models exactly the Google behaviours this PLAN relies on and nothing it
// does not (Assumptions):
//   * client-supplied event ids in `[a-v0-9]{5,1024}`;
//   * `etag` on every response, `If-Match` enforcement with 412;
//   * the **two documented outcomes for a re-used id** — `collisionMode:
//     'duplicate'` (409) and `'land'` (the late insert succeeds) — where a
//     held insert released while a non-cancelled event still exists under the
//     id answers 409 in *both* modes and lands only after that event was
//     deleted (C6.3a);
//   * `marloAttemptId` on every insert, returned by `get`/`list`, and an
//     insert **rejected** when it is missing (REV6-01).
//
// Delayed execution is first-class: an insert can be held so its caller sees a
// timeout while the request is still "in flight at Google", then released to
// land arbitrarily later — the interleaving C6.3a exists for.

import {
  AlreadyExistsError,
  AvailabilityUnknownError,
  CalendarError,
  PreconditionFailedError,
  classifyCalendarError,
  isAbsenceStatus,
  DEFINITE,
} from './errors';
import {
  isValidCalendarEventId,
  type CalendarClient,
  type CalendarEvent,
  type CalendarListItem,
  type DeleteEventInput,
  type DeleteOutcome,
  type GetEventInput,
  type InsertEventInput,
  type ListEventsInput,
  type PatchEventInput,
  type SendUpdates,
} from './calendar';

export type CollisionMode = 'duplicate' | 'land';

export type CalendarCallKind = 'insert' | 'get' | 'patch' | 'delete' | 'list';

export type CalendarCall = {
  kind: CalendarCallKind;
  calendarId: string;
  eventId?: string;
  attemptId?: string;
  ifMatch?: string;
  sendUpdates?: SendUpdates;
  start?: string;
  end?: string;
};

export type StoredEvent = CalendarEvent & { calendarId: string };

export type HeldInsert = {
  attemptId: string;
  input: InsertEventInput;
  /** How the caller's promise was settled when the request was captured. */
  answer: 'timeout' | 'defer';
  executed: boolean;
  delivered: boolean;
};

export type HoldOptions = {
  /**
   * `timeout` — settle the caller's promise now with an ambiguous error while
   * the request stays in flight at Google (AC-11(j)).
   * `defer` — leave the caller awaiting; `deliverHeld` settles it (AC-11(n)).
   */
  answer?: 'timeout' | 'defer';
  /** Apply the insert at Google immediately (response still withheld). */
  execute?: boolean;
};

export type ScriptedOutcome =
  | { status: number }
  | { throw: unknown };

export type MockCalendar = CalendarClient & {
  readonly calls: CalendarCall[];
  /** Every non-cancelled event currently on the fake calendar. */
  liveEvents(): StoredEvent[];
  allEvents(): StoredEvent[];
  eventById(id: string): StoredEvent | null;
  setCollisionMode(mode: CollisionMode): void;
  collisionMode(): CollisionMode;
  /** A foreign (non-Marlo) busy item for the external-availability read (C7). */
  seedExternal(event: { id: string; start: string; end: string; calendarId?: string; transparency?: 'opaque' | 'transparent'; status?: 'confirmed' | 'cancelled'; allDay?: boolean }): void;
  /** A managed item planted directly, for host-edited / late-landing cases. */
  seedManaged(event: { id: string; start: string; end: string; bookingId: string; attemptId?: string; calendarId?: string; status?: 'confirmed' | 'cancelled' }): void;
  /** Next call of `kind` answers this outcome instead of executing. */
  failNext(kind: CalendarCallKind, outcome: ScriptedOutcome): void;
  /** Every `list` call throws until cleared — models a Calendar outage. */
  failListWith(outcome: ScriptedOutcome | null): void;
  holdNextInsert(options?: HoldOptions): void;
  heldInserts(): HeldInsert[];
  /** Applies a held insert at Google without settling its caller. */
  executeHeld(attemptId: string): void;
  /** Applies (if not yet applied) and settles the caller's promise. */
  releaseHeld(attemptId: string): Promise<void>;
  /** Settles a deferred caller with the outcome its execution produced. */
  deliverHeld(attemptId: string): Promise<void>;
  reset(): void;
};

export function createMockCalendar(
  options: { collisionMode?: CollisionMode } = {},
): MockCalendar {
  const events = new Map<string, StoredEvent>();
  const calls: CalendarCall[] = [];
  const held = new Map<string, HeldInsert & { settle?: (outcome: 'ok' | 'error') => void }>();
  const scripted = new Map<CalendarCallKind, ScriptedOutcome[]>();
  let collision: CollisionMode = options.collisionMode ?? 'duplicate';
  let listFailure: ScriptedOutcome | null = null;
  let holdNext: HoldOptions | null = null;
  let etagSeq = 0;

  const nextEtag = (): string => {
    etagSeq += 1;
    return `etag-${etagSeq}`;
  };

  function takeScripted(kind: CalendarCallKind): ScriptedOutcome | null {
    const queue = scripted.get(kind);
    if (!queue || queue.length === 0) {
      return null;
    }
    return queue.shift() ?? null;
  }

  /**
   * A scripted 404/410 means "the resource is not there", which `get` and
   * `remove` map to absent rather than to a failure — the same mapping the live
   * adapter applies (C6.0: 404/410 is a *definite* rejection on insert and
   * patch, a tolerated absence on get and delete). Without this, scripting a
   * 404 on delete would produce `calendar_delete_failed` for exactly the case
   * C6.7 tolerates.
   */
  function describeFailure(outcome: ScriptedOutcome): string {
    if ('status' in outcome) {
      return `events.list ${outcome.status}`;
    }
    return outcome.throw instanceof Error ? outcome.throw.message : String(outcome.throw);
  }

  function scriptedAbsence(outcome: ScriptedOutcome | null): boolean {
    return outcome !== null && 'status' in outcome && isAbsenceStatus(outcome);
  }

  function raise(outcome: ScriptedOutcome): never {
    if ('throw' in outcome) {
      throw outcome.throw;
    }
    const klass = classifyCalendarError(outcome.status);
    if (klass === 'already_exists') {
      throw new AlreadyExistsError();
    }
    if (klass === 'precondition_failed') {
      throw new PreconditionFailedError();
    }
    throw new CalendarError(klass, outcome.status, `calendar_${outcome.status}`);
  }

  function ambiguous(message: string): CalendarError {
    // No status: the classifier treats it as ambiguous (timeout/network).
    return new CalendarError('ambiguous', null, message);
  }

  function applyInsert(input: InsertEventInput): CalendarEvent {
    const existing = events.get(input.id);
    if (existing && existing.status !== 'cancelled') {
      // A live event already occupies the id: 409 in BOTH collision modes.
      throw new AlreadyExistsError();
    }
    if (existing && collision === 'duplicate') {
      // Google refused to reuse a retired id.
      throw new AlreadyExistsError();
    }
    const stored: StoredEvent = {
      calendarId: input.calendarId,
      id: input.id,
      status: 'confirmed',
      start: input.start,
      end: input.end,
      etag: nextEtag(),
      summary: input.summary,
      attendees: input.attendees?.map((attendee) => ({ ...attendee })),
      marloBookingId: input.bookingId,
      marloAttemptId: input.attemptId,
    };
    events.set(stored.id, stored);
    return clone(stored);
  }

  const client: MockCalendar = {
    calls,

    async insert(input: InsertEventInput): Promise<CalendarEvent> {
      calls.push({
        kind: 'insert',
        calendarId: input.calendarId,
        eventId: input.id,
        attemptId: input.attemptId,
        sendUpdates: input.sendUpdates,
        start: input.start,
        end: input.end,
      });
      if (!isValidCalendarEventId(input.id)) {
        throw new CalendarError(DEFINITE, 400, 'invalid event id');
      }
      if (!input.attemptId) {
        // Every insert must be attributable (REV6-01).
        throw new CalendarError(DEFINITE, 400, 'marloAttemptId is required');
      }
      const failure = takeScripted('insert');
      if (failure) {
        raise(failure);
      }

      if (holdNext) {
        const holdOptions = holdNext;
        holdNext = null;
        const record: HeldInsert & { settle?: (outcome: 'ok' | 'error') => void } = {
          attemptId: input.attemptId,
          input: { ...input },
          answer: holdOptions.answer ?? 'timeout',
          executed: false,
          delivered: false,
        };
        held.set(input.attemptId, record);
        if (holdOptions.execute) {
          try {
            applyInsert(record.input);
            record.executed = true;
          } catch {
            record.executed = false;
          }
        }
        if (record.answer === 'timeout') {
          record.delivered = true;
          // Ambiguous for the caller; the request is still in flight.
          throw ambiguous('insert timed out');
        }
        return new Promise<CalendarEvent>((resolve, reject) => {
          record.settle = (outcome) => {
            record.delivered = true;
            const landed = events.get(record.input.id);
            if (
              outcome === 'ok' &&
              landed &&
              landed.marloAttemptId === record.attemptId &&
              landed.status !== 'cancelled'
            ) {
              resolve(clone(landed));
              return;
            }
            if (outcome === 'ok' && record.executed) {
              // Executed, then deleted by a reaper before delivery: the
              // response still reports the 2xx this request produced.
              resolve({
                id: record.input.id,
                status: 'confirmed',
                start: record.input.start,
                end: record.input.end,
                etag: `etag-delivered-${record.attemptId}`,
                summary: record.input.summary,
                marloBookingId: record.input.bookingId,
                marloAttemptId: record.attemptId,
              });
              return;
            }
            reject(new AlreadyExistsError());
          };
        });
      }

      return applyInsert(input);
    },

    async get(input: GetEventInput): Promise<CalendarEvent | null> {
      calls.push({ kind: 'get', calendarId: input.calendarId, eventId: input.eventId });
      const failure = takeScripted('get');
      if (scriptedAbsence(failure)) {
        return null;
      }
      if (failure) {
        raise(failure);
      }
      const found = events.get(input.eventId);
      if (!found || found.status === 'cancelled') {
        return null;
      }
      return clone(found);
    },

    async patch(input: PatchEventInput): Promise<CalendarEvent> {
      calls.push({
        kind: 'patch',
        calendarId: input.calendarId,
        eventId: input.eventId,
        ifMatch: input.ifMatch,
        sendUpdates: input.sendUpdates,
        start: input.start,
        end: input.end,
      });
      const failure = takeScripted('patch');
      if (failure) {
        raise(failure);
      }
      const found = events.get(input.eventId);
      if (!found || found.status === 'cancelled') {
        throw new CalendarError(DEFINITE, 404, 'not found');
      }
      if (found.etag !== input.ifMatch) {
        throw new PreconditionFailedError();
      }
      const updated: StoredEvent = {
        ...found,
        start: input.start ?? found.start,
        end: input.end ?? found.end,
        summary: input.summary ?? found.summary,
        attendees: input.attendees
          ? input.attendees.map((attendee) => ({ ...attendee }))
          : found.attendees,
        marloOpGen: input.opGen ?? found.marloOpGen,
        etag: nextEtag(),
      };
      events.set(updated.id, updated);
      return clone(updated);
    },

    async remove(input: DeleteEventInput): Promise<DeleteOutcome> {
      calls.push({
        kind: 'delete',
        calendarId: input.calendarId,
        eventId: input.eventId,
        ifMatch: input.ifMatch,
        sendUpdates: input.sendUpdates,
      });
      const failure = takeScripted('delete');
      if (scriptedAbsence(failure)) {
        return 'absent';
      }
      if (failure) {
        raise(failure);
      }
      const found = events.get(input.eventId);
      if (!found || found.status === 'cancelled') {
        // Tolerated 404/410.
        return 'absent';
      }
      if (found.etag !== input.ifMatch) {
        throw new PreconditionFailedError();
      }
      events.set(found.id, { ...found, status: 'cancelled', etag: nextEtag() });
      return 'deleted';
    },

    async list(input: ListEventsInput): Promise<CalendarListItem[]> {
      calls.push({
        kind: 'list',
        calendarId: input.calendarId,
        start: input.timeMin,
        end: input.timeMax,
      });
      // Fail-closed (AC-7 / C7), exactly as the live adapter does: a non-2xx, an
      // unparseable page, or an error mid-pagination is `AvailabilityUnknown` —
      // never a short list, and never a raw error that would surface as a 500
      // instead of 503 `availability_unknown`.
      if (listFailure) {
        throw new AvailabilityUnknownError(describeFailure(listFailure));
      }
      const failure = takeScripted('list');
      if (failure) {
        throw new AvailabilityUnknownError(describeFailure(failure));
      }
      const minMs = Date.parse(input.timeMin);
      const maxMs = Date.parse(input.timeMax);
      return [...events.values()]
        .filter((event) => event.calendarId === input.calendarId)
        .filter((event) => event.status !== 'cancelled')
        .filter((event) => {
          const start = Date.parse(event.start);
          const end = Date.parse(event.end);
          return start < maxMs && minMs < end;
        })
        .map((event) => clone(event) as CalendarListItem);
    },

    liveEvents: () =>
      [...events.values()].filter((event) => event.status !== 'cancelled').map(clone),
    allEvents: () => [...events.values()].map(clone),
    eventById: (id) => {
      const found = events.get(id);
      return found ? clone(found) : null;
    },
    setCollisionMode: (mode) => {
      collision = mode;
    },
    collisionMode: () => collision,

    seedExternal(event) {
      events.set(event.id, {
        calendarId: event.calendarId ?? 'primary',
        id: event.id,
        status: event.status ?? 'confirmed',
        start: event.start,
        end: event.end,
        etag: nextEtag(),
        summary: 'external',
        transparency: event.transparency ?? 'opaque',
        allDay: event.allDay,
      } as StoredEvent);
    },

    seedManaged(event) {
      events.set(event.id, {
        calendarId: event.calendarId ?? 'primary',
        id: event.id,
        status: event.status ?? 'confirmed',
        start: event.start,
        end: event.end,
        etag: nextEtag(),
        summary: 'managed',
        marloBookingId: event.bookingId,
        marloAttemptId: event.attemptId,
      });
    },

    failNext(kind, outcome) {
      const queue = scripted.get(kind) ?? [];
      queue.push(outcome);
      scripted.set(kind, queue);
    },

    failListWith(outcome) {
      listFailure = outcome;
    },

    holdNextInsert(holdOptions = {}) {
      holdNext = holdOptions;
    },

    heldInserts: () =>
      [...held.values()].map((record) => ({
        attemptId: record.attemptId,
        input: { ...record.input },
        answer: record.answer,
        executed: record.executed,
        delivered: record.delivered,
      })),

    executeHeld(attemptId) {
      const record = held.get(attemptId);
      if (!record || record.executed) {
        return;
      }
      try {
        applyInsert(record.input);
        record.executed = true;
      } catch {
        record.executed = false;
      }
    },

    async releaseHeld(attemptId) {
      const record = held.get(attemptId);
      if (!record) {
        return;
      }
      if (!record.executed) {
        try {
          applyInsert(record.input);
          record.executed = true;
        } catch {
          record.executed = false;
        }
      }
      record.settle?.(record.executed ? 'ok' : 'error');
      await Promise.resolve();
    },

    async deliverHeld(attemptId) {
      const record = held.get(attemptId);
      if (!record) {
        return;
      }
      record.settle?.(record.executed ? 'ok' : 'error');
      await Promise.resolve();
    },

    reset() {
      events.clear();
      calls.length = 0;
      held.clear();
      scripted.clear();
      listFailure = null;
      holdNext = null;
      collision = options.collisionMode ?? 'duplicate';
      etagSeq = 0;
    },
  };

  return client;
}

function clone(event: StoredEvent): StoredEvent {
  return {
    ...event,
    attendees: event.attendees?.map((attendee) => ({ ...attendee })),
  };
}
