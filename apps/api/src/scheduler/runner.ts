// The thin runner around `runTick`: an interval, a non-overlap guard, and one log line per tick.
// Everything here is a pure function or a timer so that `index.ts` holds only the wiring.
// design.md "The scheduler" owns the contract.

import type { TickResult } from './tick';

export const SCHEDULER_ENV_NAMES = {
  intervalMs: 'SCHEDULER_INTERVAL_MS',
  now: 'SCHEDULER_NOW',
} as const;

export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * A complete ISO 8601 instant: a date, a time to at least the minute, and an explicit offset.
 *
 * `new Date()` alone is too lenient for a value the tick compares against `scheduled_at`: a bare
 * date parses as midnight UTC, which would make every earlier reminder of that day due instead of
 * the peak minute, and a time without an offset parses in the machine's local zone, so the same
 * value would mean a different instant on every machine. Shape is checked here and validity
 * (`2026-13-45T25:00:00Z` has the shape) by `Date` afterwards.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/** What a tick a still-running tick blocked reports instead of a result. */
export const SKIPPED = 'skipped';

export type SchedulerConfig = {
  intervalMs: number;
  /**
   * A fixed instant every tick treats as the current time, or null for the wall clock.
   *
   * This is a measurement affordance, not a clock: the seed's target date is a fixed future
   * date, so nothing is ever due by the wall clock on the day a measured run happens. Any
   * deployment leaves `SCHEDULER_NOW` unset (design.md "The scheduler").
   */
  now: Date | null;
};

export function readSchedulerConfig(env: Record<string, string | undefined>): SchedulerConfig {
  const rawInterval = env[SCHEDULER_ENV_NAMES.intervalMs];
  let intervalMs = DEFAULT_INTERVAL_MS;
  if (rawInterval !== undefined && rawInterval !== '') {
    intervalMs = Number(rawInterval);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `${SCHEDULER_ENV_NAMES.intervalMs} must be a positive integer, got "${rawInterval}"`,
      );
    }
  }

  const rawNow = env[SCHEDULER_ENV_NAMES.now];
  if (rawNow === undefined || rawNow === '') return { intervalMs, now: null };
  const now = new Date(rawNow);
  if (!ISO_INSTANT.test(rawNow) || Number.isNaN(now.getTime())) {
    throw new Error(
      `${SCHEDULER_ENV_NAMES.now} must be an ISO 8601 instant with a time and an offset, got "${rawNow}"`,
    );
  }
  return { intervalMs, now };
}

/**
 * Wrap a tick so that a tick still in flight blocks the next one instead of overlapping it.
 *
 * The blocked tick is skipped rather than queued, which is what design.md "What M1 deliberately
 * does not do" describes: a fan-out that spills past its minute leaves its remaining reminders
 * `pending`, and the next tick that does start picks them up because the query is `<= now`.
 */
export function createNonOverlappingTick<T>(
  tick: () => Promise<T>,
): () => Promise<T | typeof SKIPPED> {
  let inFlight = false;
  return async () => {
    if (inFlight) return SKIPPED;
    inFlight = true;
    try {
      return await tick();
    } finally {
      inFlight = false;
    }
  };
}

/** One line per tick: what was due, what happened to it, and how long it took. */
export function formatTickLine(outcome: TickResult | typeof SKIPPED, at: Date): string {
  const stamp = at.toISOString();
  if (outcome === SKIPPED) {
    return `${stamp} tick skipped: the previous tick is still sending`;
  }
  const { due, sent, failed, elapsedMs } = outcome;
  return `${stamp} tick due=${due} sent=${sent} failed=${failed} elapsed=${(elapsedMs / 1000).toFixed(1)}s`;
}

export type SchedulerRuntime = {
  tick: () => Promise<TickResult>;
  intervalMs: number;
  log?: (line: string) => void;
  onError?: (error: unknown) => void;
};

/**
 * Tick immediately and then on the interval.
 *
 * The first tick does not wait for the interval: a scheduler that prints nothing for a minute is
 * indistinguishable from one that was never started, and a measured run waits on its first line.
 * There is no stop handle, because stopping cleanly is M2's deliverable.
 */
export function startScheduler({ tick, intervalMs, log = console.log, onError }: SchedulerRuntime) {
  const guarded = createNonOverlappingTick(tick);
  const run = async () => {
    try {
      log(formatTickLine(await guarded(), new Date()));
    } catch (error) {
      if (onError) onError(error);
      else console.error(error);
    }
  };
  void run();
  return setInterval(() => void run(), intervalMs);
}
