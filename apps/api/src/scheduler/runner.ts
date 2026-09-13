// The thin runner around a tick — `runTick` or `enqueueTick`, picked by `SCHEDULER_MODE`: an
// interval, a non-overlap guard, and one log line per tick.
// Everything here is a pure function or a timer so that `index.ts` holds only the wiring.
// design.md "The scheduler" owns the contract.

import type { EnqueueTickResult } from './enqueue';
import type { TickResult } from './tick';

export const SCHEDULER_ENV_NAMES = {
  intervalMs: 'SCHEDULER_INTERVAL_MS',
  now: 'SCHEDULER_NOW',
  mode: 'SCHEDULER_MODE',
} as const;

export const DEFAULT_INTERVAL_MS = 60_000;

/**
 * `enqueue` is the M2 tick and the default. `naive` is the M1 send kept as a measurement
 * affordance: the M1 row has to stay reproducible under later schema versions, and only the code
 * that produced it can reproduce it (design.md "The scheduler").
 */
export const SCHEDULER_MODES = ['enqueue', 'naive'] as const;
export type SchedulerMode = (typeof SCHEDULER_MODES)[number];
export const DEFAULT_MODE: SchedulerMode = 'enqueue';

function isSchedulerMode(value: string): value is SchedulerMode {
  return (SCHEDULER_MODES as readonly string[]).includes(value);
}

/**
 * A complete ISO 8601 instant: a date, a time to at least the minute, and an explicit offset.
 *
 * `new Date()` alone is too lenient for a value the tick compares against `scheduled_at`: a bare
 * date parses as midnight UTC, which would make every earlier reminder of that day due instead of
 * the peak minute, and a time without an offset parses in the machine's local zone, so the same
 * value would mean a different instant on every machine. Shape is checked here; the components
 * are then read back through `namesRealInstant`, because `Date` is lenient one step further.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Whether the calendar components of a shape-valid instant name a real one.
 *
 * `Date` rejects some impossible values (`2026-13-01`, `12:60`) and normalizes others: a 30
 * February becomes 2 March and a 24th hour the next day's midnight, each a different instant from
 * the one written, and the tick would select against it in silence. Reading the components back
 * as UTC and comparing them to what was written catches every normalized value, because a value
 * that normalized reads back changed. The offset is checked the same way, since `Date` accepts
 * `+99:00` on some runtimes and not others.
 */
function namesRealInstant(match: RegExpMatchArray): boolean {
  // Groups 1..6 are year, month, day, hour, minute and the optional second; group 7 the offset.
  const [year = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] = match
    .slice(1, 7)
    .map((part) => Number(part ?? '0'));
  const offset = match[7] ?? '';
  const readBack = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const componentsHold =
    readBack.getUTCFullYear() === year &&
    readBack.getUTCMonth() === month - 1 &&
    readBack.getUTCDate() === day &&
    readBack.getUTCHours() === hour &&
    readBack.getUTCMinutes() === minute &&
    readBack.getUTCSeconds() === second;
  const offsetHolds =
    offset === 'Z' || (Number(offset.slice(1, 3)) <= 23 && Number(offset.slice(4, 6)) <= 59);
  return componentsHold && offsetHolds;
}

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
  mode: SchedulerMode;
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

  const rawMode = env[SCHEDULER_ENV_NAMES.mode];
  let mode: SchedulerMode = DEFAULT_MODE;
  if (rawMode !== undefined && rawMode !== '') {
    if (!isSchedulerMode(rawMode)) {
      throw new Error(
        `${SCHEDULER_ENV_NAMES.mode} must be one of ${SCHEDULER_MODES.join(', ')}, got "${rawMode}"`,
      );
    }
    mode = rawMode;
  }

  const rawNow = env[SCHEDULER_ENV_NAMES.now];
  if (rawNow === undefined || rawNow === '') return { intervalMs, now: null, mode };
  const shape = rawNow.match(ISO_INSTANT);
  const now = new Date(rawNow);
  if (shape === null || !namesRealInstant(shape) || Number.isNaN(now.getTime())) {
    throw new Error(
      `${SCHEDULER_ENV_NAMES.now} must be an ISO 8601 instant with a time and an offset, got "${rawNow}"`,
    );
  }
  return { intervalMs, now, mode };
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

/** What a tick returns in either mode: the naive send's counts, or the enqueue tick's. */
export type TickOutcome = TickResult | EnqueueTickResult;

/**
 * One line per tick: what was due, what happened to it, and how long it took.
 * The line names what the tick did — sent and failed counts for the naive send, an enqueued count
 * for the enqueue tick — so a log never has to be read alongside the mode that produced it.
 */
export function formatTickLine(outcome: TickOutcome | typeof SKIPPED, at: Date): string {
  const stamp = at.toISOString();
  if (outcome === SKIPPED) {
    return `${stamp} tick skipped: the previous tick has not finished`;
  }
  const elapsed = `elapsed=${(outcome.elapsedMs / 1000).toFixed(1)}s`;
  if ('enqueued' in outcome) {
    return `${stamp} tick due=${outcome.due} enqueued=${outcome.enqueued} ${elapsed}`;
  }
  const { due, sent, failed } = outcome;
  return `${stamp} tick due=${due} sent=${sent} failed=${failed} ${elapsed}`;
}

export type SchedulerRuntime = {
  tick: () => Promise<TickOutcome>;
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
