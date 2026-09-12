import { describe, expect, it } from 'bun:test';

import { localTimeToUtc, utcToLocalTime } from './time';

const iso = (localDate: string, localTime: string, timeZone: string) =>
  localTimeToUtc(localDate, localTime, timeZone).toISOString();

describe('localTimeToUtc', () => {
  it('converts the peak: 21:00 in Asia/Seoul is 12:00Z', () => {
    expect(iso('2026-09-15', '21:00', 'Asia/Seoul')).toBe('2026-09-15T12:00:00.000Z');
  });

  it('keeps that offset in January, because Asia/Seoul has no daylight saving', () => {
    expect(iso('2026-01-15', '21:00', 'Asia/Seoul')).toBe('2026-01-15T12:00:00.000Z');
  });

  it('uses the offset in force on the date, not a fixed one', () => {
    // America/New_York is UTC-4 in July and UTC-5 in January, for the same local time.
    expect(iso('2026-07-01', '21:00', 'America/New_York')).toBe('2026-07-02T01:00:00.000Z');
    expect(iso('2026-01-15', '21:00', 'America/New_York')).toBe('2026-01-16T02:00:00.000Z');
  });

  it('does the same for a zone whose winter offset is zero', () => {
    expect(iso('2026-09-15', '13:00', 'Europe/London')).toBe('2026-09-15T12:00:00.000Z');
    expect(iso('2026-01-15', '12:00', 'Europe/London')).toBe('2026-01-15T12:00:00.000Z');
  });

  it('reads the date as the local calendar day, so a reminder can land on another UTC date', () => {
    expect(iso('2026-09-15', '00:00', 'Asia/Seoul')).toBe('2026-09-14T15:00:00.000Z');
    expect(iso('2026-09-15', '23:45', 'America/New_York')).toBe('2026-09-16T03:45:00.000Z');
  });

  it('passes UTC through', () => {
    expect(iso('2026-09-15', '12:00', 'UTC')).toBe('2026-09-15T12:00:00.000Z');
  });

  // The next two cases are the only ones where this module and Postgres disagree, so they pin this
  // module's own answer and name Postgres's beside it rather than claiming to predict the engine.
  // Measured on the Postgres 16.15 image in docker-compose.yml:
  //   ('2026-03-08'::date + '02:30'::time) AT TIME ZONE 'America/New_York' -> 2026-03-08 07:30:00+00
  //   ('2026-11-01'::date + '01:30'::time) AT TIME ZONE 'America/New_York' -> 2026-11-01 06:30:00+00
  // Neither is reachable from the seed: no local time it assigns is skipped or repeated on its date.
  it('resolves a local time the spring-forward gap skips to the offset after the change', () => {
    // 02:30 never happens in America/New_York on 2026-03-08. This reads it as EDT (06:30Z);
    // Postgres reads it with the offset before the change, EST, and returns 07:30Z.
    expect(iso('2026-03-08', '02:30', 'America/New_York')).toBe('2026-03-08T06:30:00.000Z');
  });

  it('resolves a local time the autumn fold repeats to its first occurrence', () => {
    // 01:30 happens twice in America/New_York on 2026-11-01. This takes the first, EDT (05:30Z);
    // Postgres takes the second, EST, and returns 06:30Z.
    expect(iso('2026-11-01', '01:30', 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('accepts a Postgres time with seconds', () => {
    expect(iso('2026-09-15', '21:00:00', 'Asia/Seoul')).toBe('2026-09-15T12:00:00.000Z');
  });

  it('rejects input it cannot parse', () => {
    expect(() => localTimeToUtc('15-09-2026', '21:00', 'UTC')).toThrow(/YYYY-MM-DD/);
    expect(() => localTimeToUtc('2026-09-15', '9pm', 'UTC')).toThrow(/HH:MM/);
  });
});

describe('utcToLocalTime', () => {
  it('reads an instant as a wall clock in the zone', () => {
    const instant = new Date('2026-09-15T12:00:00.000Z');
    expect(utcToLocalTime(instant, 'Asia/Seoul')).toBe('21:00');
    expect(utcToLocalTime(instant, 'UTC')).toBe('12:00');
    expect(utcToLocalTime(instant, 'America/New_York')).toBe('08:00');
    expect(utcToLocalTime(instant, 'Europe/London')).toBe('13:00');
  });

  it('inverts localTimeToUtc', () => {
    for (const timeZone of ['Asia/Seoul', 'UTC', 'America/New_York', 'Europe/London']) {
      for (const localTime of ['00:00', '08:15', '12:00', '21:00', '23:45']) {
        expect(utcToLocalTime(localTimeToUtc('2026-09-15', localTime, timeZone), timeZone)).toBe(
          localTime,
        );
      }
    }
  });
});
