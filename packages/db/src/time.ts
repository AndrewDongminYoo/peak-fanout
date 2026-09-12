// The local-time-to-UTC conversion the materializer performs.
// Postgres does the real conversion with `(date + reminder_time) AT TIME ZONE timezone`
// (design.md "Reminders and delivery (M1)"); this module mirrors it in TypeScript so the seed can
// decide which local reminder times a timezone must avoid, and be tested without a database.
//
// The two agree on every local time that occurs exactly once on its date, which is every local time
// the seed assigns. They differ on the two daylight-saving edge cases, measured against the
// Postgres 16.15 image in docker-compose.yml: on 2026-03-08 in America/New_York `02:30` never
// happens, and this module reads it with the offset after the change (06:30Z) while Postgres reads
// it with the offset before (07:30Z); on 2026-11-01 `01:30` happens twice, and this module takes the
// first occurrence (05:30Z) while Postgres takes the second (06:30Z).
// time.test.ts pins this module's value for both and names the Postgres one beside it.

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = FORMATTERS.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    FORMATTERS.set(timeZone, cached);
  }
  return cached;
}

/** Milliseconds to add to `instant` to read it as a wall clock in `timeZone`. */
function offsetMs(instant: number, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  const wallClock = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return wallClock - instant;
}

function parseLocalDate(date: string): [number, number, number] {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`expected a YYYY-MM-DD date, got "${date}"`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseLocalTime(time: string): [number, number] {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!match) throw new Error(`expected an HH:MM time, got "${time}"`);
  return [Number(match[1]), Number(match[2])];
}

/**
 * The UTC instant at which `localTime` on `localDate` occurs in `timeZone`.
 *
 * The date names the local calendar day, so a reminder can land on an adjacent UTC date.
 * The offset is resolved twice because the first guess uses the offset in force at the
 * naive instant, which is the wrong one within a few hours of a daylight-saving transition.
 * A local time the transition skips or repeats has no single right answer, and the one returned
 * here is not the one Postgres returns — the file header names both.
 */
export function localTimeToUtc(localDate: string, localTime: string, timeZone: string): Date {
  const [year, month, day] = parseLocalDate(localDate);
  const [hour, minute] = parseLocalTime(localTime);
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0);
  const firstGuess = naive - offsetMs(naive, timeZone);
  return new Date(naive - offsetMs(firstGuess, timeZone));
}

/** The `HH:MM` wall clock that `instant` reads as in `timeZone`. */
export function utcToLocalTime(instant: Date, timeZone: string): string {
  const shifted = new Date(instant.getTime() + offsetMs(instant.getTime(), timeZone));
  const hour = String(shifted.getUTCHours()).padStart(2, '0');
  const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}
