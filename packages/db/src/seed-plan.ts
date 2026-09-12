// Which timezone and which local reminder time each seeded user gets.
// The peak this produces is the whole point of the demo, so the distribution is a pure function
// with its own tests rather than arithmetic hidden inside the seed's SQL.
// design.md "Reminders and delivery (M1)" owns the semantics; this file owns the numbers.

import { localTimeToUtc } from './time';

/** The timezone that holds the peak. It has no daylight saving, so its peak minute is the same on every date. */
export const TARGET_TIMEZONE = 'Asia/Seoul';

/** The local reminder time that defines the peak instant. */
export const TARGET_LOCAL_TIME = '21:00';

/** The calendar date the seed materializes reminders for, read as each user's own local date. */
export const TARGET_DATE = '2026-09-15';

export const SEED_USER_COUNT = 50_000;
export const PEAK_USER_COUNT = 8_000;
export const TARGET_TIMEZONE_USER_COUNT = 48_000;

/** Timezones the remaining users are spread over, so the conversion path sees more than one offset. */
export const OTHER_TIMEZONES = ['UTC', 'America/New_York', 'Europe/London'];

/** Off-peak users pick from a grid of local times this many minutes apart. */
export const SLOT_MINUTES = 15;

export const SEED_EMAIL_PREFIX = 'load-';
export const SEED_EMAIL_DOMAIN = '@example.test';

/** The `LIKE` pattern that matches every row the seed owns, and nothing a magic-link login created. */
export const SEED_EMAIL_LIKE = `${SEED_EMAIL_PREFIX}%${SEED_EMAIL_DOMAIN}`;

export function seedEmail(index: number): string {
  return `${SEED_EMAIL_PREFIX}${index}${SEED_EMAIL_DOMAIN}`;
}

/** The instant every peak user's reminder must land on. */
export function peakInstant(targetDate: string = TARGET_DATE): Date {
  return localTimeToUtc(targetDate, TARGET_LOCAL_TIME, TARGET_TIMEZONE);
}

/**
 * One insert's worth of seeded users: `count` consecutive indices starting at `firstIndex`,
 * all in `timezone`, cycling through `localTimes` so that index `i` gets
 * `localTimes[(i - firstIndex) % localTimes.length]`. The seed's SQL repeats that expression.
 */
export type SeedSegment = {
  timezone: string;
  firstIndex: number;
  count: number;
  localTimes: string[];
};

export type SeedAssignment = {
  index: number;
  email: string;
  timezone: string;
  reminderTime: string;
};

function localTimeGrid(): string[] {
  const slots: string[] = [];
  for (let minutes = 0; minutes < 24 * 60; minutes += SLOT_MINUTES) {
    const hour = String(Math.floor(minutes / 60)).padStart(2, '0');
    const minute = String(minutes % 60).padStart(2, '0');
    slots.push(`${hour}:${minute}`);
  }
  return slots;
}

/** Counts for the non-target timezones, distributed as evenly as the remainder allows. */
function otherTimezoneCounts(): number[] {
  const total = SEED_USER_COUNT - TARGET_TIMEZONE_USER_COUNT;
  const base = Math.floor(total / OTHER_TIMEZONES.length);
  const remainder = total - base * OTHER_TIMEZONES.length;
  return OTHER_TIMEZONES.map((_, position) => base + (position < remainder ? 1 : 0));
}

const SEGMENT_CACHE = new Map<string, SeedSegment[]>();

/**
 * The segments the seed inserts, in index order.
 *
 * Every off-peak segment drops the one local time that converts to the peak instant in its own
 * timezone on `targetDate`, which is what keeps the peak minute at exactly `PEAK_USER_COUNT`.
 */
export function seedSegments(targetDate: string = TARGET_DATE): SeedSegment[] {
  const cached = SEGMENT_CACHE.get(targetDate);
  if (cached) return cached;

  const target = peakInstant(targetDate).getTime();
  const grid = localTimeGrid();
  const offPeakTimes = (timezone: string) =>
    grid.filter(
      (localTime) => localTimeToUtc(targetDate, localTime, timezone).getTime() !== target,
    );

  const segments: SeedSegment[] = [];
  let firstIndex = 0;
  const add = (timezone: string, count: number, localTimes: string[]) => {
    segments.push({ timezone, firstIndex, count, localTimes });
    firstIndex += count;
  };

  add(TARGET_TIMEZONE, PEAK_USER_COUNT, [TARGET_LOCAL_TIME]);
  add(TARGET_TIMEZONE, TARGET_TIMEZONE_USER_COUNT - PEAK_USER_COUNT, offPeakTimes(TARGET_TIMEZONE));
  otherTimezoneCounts().forEach((count, position) => {
    const timezone = OTHER_TIMEZONES[position] as string;
    add(timezone, count, offPeakTimes(timezone));
  });

  if (firstIndex !== SEED_USER_COUNT) {
    throw new Error(`seed segments cover ${firstIndex} users, expected ${SEED_USER_COUNT}`);
  }

  SEGMENT_CACHE.set(targetDate, segments);
  return segments;
}

/** The timezone and local reminder time seeded user `index` gets. */
export function assignSeedUser(index: number, targetDate: string = TARGET_DATE): SeedAssignment {
  if (!Number.isInteger(index) || index < 0 || index >= SEED_USER_COUNT) {
    throw new Error(`seed index out of range: ${index}`);
  }
  for (const segment of seedSegments(targetDate)) {
    const position = index - segment.firstIndex;
    if (position < 0 || position >= segment.count) continue;
    const localTimes = segment.localTimes;
    return {
      index,
      email: seedEmail(index),
      timezone: segment.timezone,
      reminderTime: localTimes[position % localTimes.length] as string,
    };
  }
  throw new Error(`no seed segment covers index ${index}`);
}
