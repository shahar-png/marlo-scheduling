import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  createEventType,
  getEventType,
  getEventTypeBySlug,
  resetEventTypes,
} from '../lib/availability/event-type';
import {
  createAvailabilitySchedule,
  getAvailabilitySchedule,
  resetAvailabilitySchedules,
} from '../lib/availability/schedule';

describe('AC-1 availability-schedule stub', () => {
  beforeEach(() => {
    resetAvailabilitySchedules();
  });

  it('creates and reads a weekly schedule with IANA timezone and weekday windows', () => {
    const created = createAvailabilitySchedule({
      hostId: 'host-1',
      timezone: 'UTC',
      windows: [
        { weekday: 0, start: '09:00', end: '17:00' },
        { weekday: 1, start: '10:00', end: '16:00' },
      ],
    });

    assert.equal(created.hostId, 'host-1');
    assert.equal(created.timezone, 'UTC');
    assert.deepEqual(created.windows, [
      { weekday: 0, start: '09:00', end: '17:00' },
      { weekday: 1, start: '10:00', end: '16:00' },
    ]);
    assert.ok(created.id);

    const read = getAvailabilitySchedule(created.id);
    assert.deepEqual(read, created);
  });

  it('rejects an empty timezone', () => {
    assert.throws(
      () =>
        createAvailabilitySchedule({
          hostId: 'host-1',
          timezone: '   ',
          windows: [{ weekday: 0, start: '09:00', end: '17:00' }],
        }),
      /timezone is required/,
    );
  });

  it('rejects empty windows', () => {
    assert.throws(
      () =>
        createAvailabilitySchedule({
          hostId: 'host-1',
          timezone: 'UTC',
          windows: [],
        }),
      /windows must not be empty/,
    );
  });

  it('returns null when the schedule id is unknown', () => {
    assert.equal(getAvailabilitySchedule('missing'), null);
  });
});

describe('AC-2 one-on-one event-type stub', () => {
  beforeEach(() => {
    resetEventTypes();
  });

  it('creates and reads a one-on-one event type', () => {
    const created = createEventType({
      hostId: 'host-1',
      slug: 'intro-30',
      name: 'Intro call',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'one_on_one',
    });

    assert.equal(created.slug, 'intro-30');
    assert.equal(created.name, 'Intro call');
    assert.equal(created.durationMinutes, 30);
    assert.equal(created.availabilityScheduleId, 'sched-1');
    assert.equal(created.kind, 'one_on_one');

    assert.deepEqual(getEventType(created.id), created);
    assert.deepEqual(getEventTypeBySlug('intro-30'), created);
  });

  it('rejects collective and round_robin kinds', () => {
    for (const kind of ['collective', 'round_robin'] as const) {
      assert.throws(
        () =>
          createEventType({
            hostId: 'host-1',
            slug: `slug-${kind}`,
            name: 'Nope',
            durationMinutes: 30,
            availabilityScheduleId: 'sched-1',
            kind,
          }),
        /rejected/,
      );
    }
  });

  it('rejects a duplicate slug', () => {
    createEventType({
      hostId: 'host-1',
      slug: 'intro-30',
      name: 'Intro call',
      durationMinutes: 30,
      availabilityScheduleId: 'sched-1',
      kind: 'one_on_one',
    });

    assert.throws(
      () =>
        createEventType({
          hostId: 'host-2',
          slug: 'intro-30',
          name: 'Other',
          durationMinutes: 45,
          availabilityScheduleId: 'sched-2',
          kind: 'one_on_one',
        }),
      /slug must be unique/,
    );
  });
});
