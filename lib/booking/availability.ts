// Availability for the durable path.
//
//   availability = externalBusy(`events.list`, C7 classification)
//                ∪ managedBusy(`hostOccupancy`, C6.1)
//
// The window expansion and the candidate grid are the shipped
// `listAvailableTimes` (BOOK-FE behaviour unchanged); only the busy set and the
// increment differ. The public / owner-scoped / legacy routes keep
// `incrementMinutes = durationMinutes`; the **authenticated reschedule** policy
// uses the 15-minute grid, which is what makes an overlapping move actually
// generated rather than merely un-blocked (C12 / REV3-08).

import type { EventType } from '../availability/event-type';
import type { AvailabilitySchedule } from '../availability/schedule';
import { listAvailableTimes, rescheduleIncrementFor } from '../availability/slots';
import type { BusyWindow, CalendarProvider } from '../calendar/provider';
import { externalBusy, hostOccupancy } from './occupancy';
import type { LifecycleContext } from './ops';
import type { Interval } from './rows';

/** The busy set is supplied wholesale; this provider contributes nothing. */
const NO_FREEBUSY: CalendarProvider = {
  async freeBusy(): Promise<BusyWindow[]> {
    return [];
  },
  async createEvent() {
    throw new Error('the availability path never creates events');
  },
  async updateEvent() {
    throw new Error('the availability path never updates events');
  },
  async deleteEvent() {
    throw new Error('the availability path never deletes events');
  },
};

export type AvailabilityInput = {
  eventType: Pick<EventType, 'durationMinutes' | 'hostId'>;
  schedule: AvailabilitySchedule;
  window: Interval;
  /** Set for the reschedule picker: excludes the booking's own occupancy. */
  excludeBookingId?: string;
  /** `true` for the authenticated reschedule grid (C12). */
  reschedule?: boolean;
};

export async function durableAvailableTimes(
  ctx: LifecycleContext,
  input: AvailabilityInput,
): Promise<string[]> {
  const external = await externalBusy(ctx, {
    window: input.window,
    ...(input.excludeBookingId === undefined
      ? {}
      : { excludeBookingId: input.excludeBookingId }),
    timeZone: input.schedule.timezone,
  });
  const managed = await hostOccupancy(ctx.store, input.eventType.hostId, input.window, {
    ...(input.excludeBookingId === undefined
      ? {}
      : { excludeBookingId: input.excludeBookingId }),
  });

  return listAvailableTimes({
    eventType: { durationMinutes: input.eventType.durationMinutes },
    schedule: input.schedule,
    timeMin: input.window.start,
    timeMax: input.window.end,
    provider: NO_FREEBUSY,
    calendarId: ctx.calendarId,
    extraBusy: [...external, ...managed],
    ...(input.reschedule === true
      ? { incrementMinutes: rescheduleIncrementFor(input.eventType.durationMinutes) }
      : {}),
  });
}
