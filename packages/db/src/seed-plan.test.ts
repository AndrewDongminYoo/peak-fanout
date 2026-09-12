import { describe, expect, it } from 'bun:test';

import {
  assignSeedUser,
  OTHER_TIMEZONES,
  PEAK_USER_COUNT,
  peakInstant,
  SEED_EMAIL_PATTERN,
  seedEmail,
  SEED_USER_COUNT,
  seedSegments,
  TARGET_DATE,
  TARGET_LOCAL_TIME,
  TARGET_TIMEZONE,
  TARGET_TIMEZONE_USER_COUNT,
} from './seed-plan';
import { localTimeToUtc } from './time';

// The conversion is memoized per (timezone, local time) pair: 50,000 indices share a few hundred pairs.
const instants = new Map<string, number>();
function instantOf(timezone: string, reminderTime: string): number {
  const key = `${timezone}|${reminderTime}`;
  let instant = instants.get(key);
  if (instant === undefined) {
    instant = localTimeToUtc(TARGET_DATE, reminderTime, timezone).getTime();
    instants.set(key, instant);
  }
  return instant;
}

const everyAssignment = Array.from({ length: SEED_USER_COUNT }, (_, index) =>
  assignSeedUser(index),
);
const peak = peakInstant().getTime();

describe('seedSegments', () => {
  it('covers every index exactly once, in order', () => {
    let nextIndex = 0;
    for (const segment of seedSegments()) {
      expect(segment.firstIndex).toBe(nextIndex);
      expect(segment.count).toBeGreaterThan(0);
      expect(segment.localTimes.length).toBeGreaterThan(0);
      nextIndex += segment.count;
    }
    expect(nextIndex).toBe(SEED_USER_COUNT);
  });

  it('gives the peak segment one local time and nothing else that instant', () => {
    const [peakSegment, ...rest] = seedSegments();
    expect(peakSegment?.timezone).toBe(TARGET_TIMEZONE);
    expect(peakSegment?.count).toBe(PEAK_USER_COUNT);
    expect(peakSegment?.localTimes).toEqual([TARGET_LOCAL_TIME]);

    for (const segment of rest) {
      const colliding = segment.localTimes.filter(
        (localTime) => instantOf(segment.timezone, localTime) === peak,
      );
      expect(colliding).toEqual([]);
    }
  });

  it('drops exactly the local time each off-peak zone would collide on', () => {
    const offPeakTimes = (timezone: string) =>
      seedSegments()
        .filter((segment) => segment.timezone === timezone && segment.localTimes.length > 1)
        .flatMap((segment) => segment.localTimes);

    expect(offPeakTimes(TARGET_TIMEZONE)).not.toContain('21:00');
    expect(offPeakTimes('UTC')).not.toContain('12:00');
    expect(offPeakTimes('America/New_York')).not.toContain('08:00');
    expect(offPeakTimes('Europe/London')).not.toContain('13:00');
    expect(offPeakTimes('UTC')).toContain('11:45');
  });
});

describe('assignSeedUser', () => {
  it('assigns every index once, with a unique email', () => {
    expect(everyAssignment).toHaveLength(SEED_USER_COUNT);
    expect(new Set(everyAssignment.map((user) => user.email)).size).toBe(SEED_USER_COUNT);
    expect(everyAssignment[0]?.email).toBe('load-0@example.test');
    expect(everyAssignment[SEED_USER_COUNT - 1]?.email).toBe('load-49999@example.test');
  });

  it('puts 48,000 users in the target timezone and the rest across the others', () => {
    const byTimezone = new Map<string, number>();
    for (const user of everyAssignment) {
      byTimezone.set(user.timezone, (byTimezone.get(user.timezone) ?? 0) + 1);
    }

    expect(byTimezone.get(TARGET_TIMEZONE)).toBe(TARGET_TIMEZONE_USER_COUNT);
    expect(byTimezone.size).toBe(1 + OTHER_TIMEZONES.length);
    for (const timezone of OTHER_TIMEZONES) {
      expect(byTimezone.get(timezone)).toBeGreaterThan(0);
    }
    const others = OTHER_TIMEZONES.reduce(
      (total, timezone) => total + (byTimezone.get(timezone) ?? 0),
      0,
    );
    expect(others).toBe(SEED_USER_COUNT - TARGET_TIMEZONE_USER_COUNT);
  });

  it('lands exactly 8,000 users on the peak instant, all of them in the target timezone', () => {
    const onPeak = everyAssignment.filter(
      (user) => instantOf(user.timezone, user.reminderTime) === peak,
    );

    expect(onPeak).toHaveLength(PEAK_USER_COUNT);
    expect(new Set(onPeak.map((user) => user.timezone))).toEqual(new Set([TARGET_TIMEZONE]));
    expect(new Set(onPeak.map((user) => user.reminderTime))).toEqual(new Set([TARGET_LOCAL_TIME]));
    expect(new Set(onPeak.map((user) => user.index))).toEqual(
      new Set(Array.from({ length: PEAK_USER_COUNT }, (_, index) => index)),
    );
  });

  it('leaves the peak minute the busiest by a wide margin', () => {
    const perMinute = new Map<number, number>();
    for (const user of everyAssignment) {
      const instant = instantOf(user.timezone, user.reminderTime);
      perMinute.set(instant, (perMinute.get(instant) ?? 0) + 1);
    }

    const busiestOffPeak = Math.max(
      ...[...perMinute].filter(([instant]) => instant !== peak).map(([, count]) => count),
    );
    expect(perMinute.get(peak)).toBe(PEAK_USER_COUNT);
    expect(busiestOffPeak).toBeLessThan(PEAK_USER_COUNT);
  });

  it('refuses an index outside the seeded population', () => {
    expect(() => assignSeedUser(-1)).toThrow(/out of range/);
    expect(() => assignSeedUser(SEED_USER_COUNT)).toThrow(/out of range/);
    expect(() => assignSeedUser(1.5)).toThrow(/out of range/);
  });
});

describe('SEED_EMAIL_PATTERN', () => {
  // The predicate decides which rows a seed run deletes, so it has to match the addresses the seed
  // generates and refuse everything else. A `LIKE` pattern cannot: `load-%@example.test` also
  // matches `load-alice@example.test`, and deleting that row would cascade its reminders and
  // deliveries away from a developer who had signed a magic link with a seed-shaped address.
  const pattern = new RegExp(SEED_EMAIL_PATTERN);

  it('matches every address the seed generates', () => {
    for (const index of [0, 1, 7999, 8000, SEED_USER_COUNT - 1]) {
      expect(pattern.test(seedEmail(index))).toBe(true);
    }
  });

  it('refuses a seed-shaped address that the seed did not generate', () => {
    for (const email of [
      'load-alice@example.test',
      'load-admin@example.test',
      'load-@example.test',
      'load-1a@example.test',
      'load-1@example.test.evil',
      'xload-1@example.test',
      'load-1@other.test',
    ]) {
      expect(pattern.test(email)).toBe(false);
    }
  });
});
