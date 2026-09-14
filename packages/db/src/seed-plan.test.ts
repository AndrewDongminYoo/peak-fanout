import { describe, expect, it } from 'bun:test';

import {
  assignSeedUser,
  EXPRESSION_COUNT,
  EXPRESSION_LANG,
  EXPRESSION_LEVELS,
  M4_EXPRESSION_COUNT,
  OTHER_TIMEZONES,
  PEAK_USER_COUNT,
  peakInstant,
  seedEmail,
  seedExpression,
  readExpressionCount,
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

describe('seedEmail', () => {
  // Ownership is recorded in `users.seeded`, not inferred from these addresses (design.md "The seed
  // owns its rows by a recorded flag, not by their address"), so what matters here is only that the
  // seed's own addresses are distinct — a collision would break the unique index mid-insert.
  it('is distinct for every seeded index', () => {
    const seen = new Set<string>();
    for (let index = 0; index < SEED_USER_COUNT; index += 1) seen.add(seedEmail(index));
    expect(seen.size).toBe(SEED_USER_COUNT);
    expect(seedEmail(0)).toBe('load-0@example.test');
    expect(seedEmail(SEED_USER_COUNT - 1)).toBe('load-49999@example.test');
  });
});

describe('seedExpression', () => {
  // The content rule the seed's one insert repeats in SQL (design.md "Data model"): original
  // placeholder text at a dense position, cycling through the levels.
  it('writes 1,000 rows, a number M4 scales with its own flag', () => {
    expect(EXPRESSION_COUNT).toBe(1_000);
    expect(M4_EXPRESSION_COUNT).toBe(5_000_000);
  });

  it('keeps the normal seed small and selects the exact M4 population only with its flag', () => {
    expect(readExpressionCount({})).toBe(EXPRESSION_COUNT);
    expect(readExpressionCount({ SEED_M4_EXPRESSIONS: '1' })).toBe(M4_EXPRESSION_COUNT);
  });

  it('refuses a misspelled M4 flag instead of silently running the normal seed', () => {
    for (const value of ['', '0', 'true', '01', ' 1']) {
      expect(() => readExpressionCount({ SEED_M4_EXPRESSIONS: value })).toThrow(
        `SEED_M4_EXPRESSIONS must be 1 or unset, got "${value}"`,
      );
    }
  });

  it('gives position i placeholder text naming i, in the one seeded language', () => {
    expect(seedExpression(1)).toEqual({
      position: 1,
      lang: EXPRESSION_LANG,
      text: 'expression 1',
      translation: 'translation 1',
      level: 2,
    });
    expect(seedExpression(1_000)).toEqual({
      position: 1_000,
      lang: 'en',
      text: 'expression 1000',
      translation: 'translation 1000',
      level: 1,
    });
    expect(seedExpression(M4_EXPRESSION_COUNT, M4_EXPRESSION_COUNT)).toEqual({
      position: M4_EXPRESSION_COUNT,
      lang: 'en',
      text: 'expression 5000000',
      translation: 'translation 5000000',
      level: 1,
    });
  });

  it('cycles the level through 1..EXPRESSION_LEVELS as (position % levels) + 1', () => {
    const levels = new Set<number>();
    for (let position = 1; position <= EXPRESSION_COUNT; position += 1) {
      const { level } = seedExpression(position);
      expect(level).toBe((position % EXPRESSION_LEVELS) + 1);
      levels.add(level);
    }
    expect([...levels].sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('refuses a position outside 1..EXPRESSION_COUNT', () => {
    expect(() => seedExpression(0)).toThrow(/out of range/);
    expect(() => seedExpression(EXPRESSION_COUNT + 1)).toThrow(/out of range/);
    expect(() => seedExpression(1.5)).toThrow(/out of range/);
    expect(() => seedExpression(M4_EXPRESSION_COUNT + 1, M4_EXPRESSION_COUNT)).toThrow(
      /out of range/,
    );
  });
});
