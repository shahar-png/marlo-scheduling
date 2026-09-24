// One injectable clock for every time-dependent rule: the 2-minute operation
// stale window (C6.3), the delivery claim stale window (C5), and the bounded
// health readiness deadline (C13). Tests substitute `createFakeClock()` so none
// of those depend on wall-clock progress.

export type Clock = {
  /** Epoch milliseconds. */
  now(): number;
  /** Resolves after `ms` of this clock's time. */
  sleep(ms: number): Promise<void>;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

export type FakeClock = Clock & {
  /** Moves the clock forward and releases every sleeper that is now due. */
  advance(ms: number): Promise<void>;
  /** Pins the clock without releasing sleepers (frozen-clock cases). */
  set(ms: number): void;
  pendingSleepers(): number;
};

export function createFakeClock(startMs = Date.parse('2026-09-21T09:00:00.000Z')): FakeClock {
  let current = startMs;
  let sleepers: { dueAt: number; resolve: () => void }[] = [];

  return {
    now: () => current,
    sleep(ms: number) {
      if (ms <= 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        sleepers.push({ dueAt: current + ms, resolve });
      });
    },
    async advance(ms: number) {
      current += ms;
      const due = sleepers.filter((sleeper) => sleeper.dueAt <= current);
      sleepers = sleepers.filter((sleeper) => sleeper.dueAt > current);
      for (const sleeper of due) {
        sleeper.resolve();
      }
      // Let the released continuations run before the caller asserts.
      await Promise.resolve();
      await Promise.resolve();
    },
    set(ms: number) {
      current = ms;
    },
    pendingSleepers: () => sleepers.length,
  };
}

export function isoOf(clock: Clock): string {
  return new Date(clock.now()).toISOString();
}
