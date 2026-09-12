// Seeds the M1 peak: 50,000 users and one reminder each for the target date.
// design.md "Reminders and delivery (M1)" owns the distribution; packages/db/src/seed-plan.ts owns its numbers.
//
//   DATABASE_URL=postgres://peak:peak@localhost:5432/peak bun run db:seed
//
// Every insert is one statement over generate_series, so the row count costs round trips
// proportional to the number of segments rather than to the number of users.

import postgres from 'postgres';

import { requireLoopbackDatabaseUrl } from './seed-guard';
import {
  PEAK_USER_COUNT,
  SEED_EMAIL_DOMAIN,
  SEED_EMAIL_LIKE,
  SEED_EMAIL_PREFIX,
  seedSegments,
  TARGET_DATE,
  type SeedSegment,
} from './seed-plan';
import { formatVerifyRows, verifyPeak } from './verify-peak';

type Client = ReturnType<typeof postgres>;

/** Removes the rows the seed owns. Real users created by a magic-link login do not match the pattern. */
async function deleteSeededUsers(sql: Client): Promise<number> {
  const deleted = await sql`DELETE FROM users WHERE email LIKE ${SEED_EMAIL_LIKE}`;
  return deleted.count;
}

/**
 * Inserts one segment's users, giving index `i` the local time at
 * `localTimes[(i - firstIndex) % localTimes.length]` — the expression `assignSeedUser` mirrors.
 */
async function insertSegment(sql: Client, segment: SeedSegment): Promise<number> {
  const lastIndex = segment.firstIndex + segment.count - 1;
  const inserted = await sql`
    WITH slot AS (
      SELECT position - 1 AS slot_position, local_time::time AS reminder_time
      FROM unnest(${segment.localTimes}::text[]) WITH ORDINALITY AS t(local_time, position)
    )
    INSERT INTO users (email, timezone, reminder_time)
    SELECT
      ${SEED_EMAIL_PREFIX} || s.i || ${SEED_EMAIL_DOMAIN},
      ${segment.timezone},
      slot.reminder_time
    FROM generate_series(${segment.firstIndex}::int, ${lastIndex}::int) AS s(i)
    JOIN slot
      ON slot.slot_position = (s.i - ${segment.firstIndex}::int) % ${segment.localTimes.length}::int
  `;
  return inserted.count;
}

/**
 * The materializer: one date plus the users matching `emailLike` becomes one `reminders` row each,
 * at that user's local `reminder_time` converted to UTC for that date.
 *
 * The population is a parameter because the seed may only write rows its own delete can remove
 * (design.md "Reminders and delivery (M1)"); pass `'%'` to materialize for the whole table.
 * Nothing in M1 runs this on a schedule.
 */
export async function materializeReminders(
  sql: Client,
  targetDate: string,
  emailLike: string,
): Promise<number> {
  const inserted = await sql`
    INSERT INTO reminders (user_id, scheduled_at)
    SELECT u.id, (${targetDate}::date + u.reminder_time) AT TIME ZONE u.timezone
    FROM users AS u
    WHERE u.email LIKE ${emailLike}
    ON CONFLICT (user_id, scheduled_at) DO NOTHING
  `;
  return inserted.count;
}

async function seed(sql: Client, targetDate: string): Promise<boolean> {
  const startedAt = Date.now();

  const deleted = await deleteSeededUsers(sql);
  console.log(`deleted ${deleted} previously seeded users (and their reminders)`);

  let users = 0;
  for (const segment of seedSegments(targetDate)) {
    const inserted = await insertSegment(sql, segment);
    users += inserted;
    console.log(
      `inserted ${inserted} users in ${segment.timezone} over ${segment.localTimes.length} local time(s)`,
    );
  }

  const reminders = await materializeReminders(sql, targetDate, SEED_EMAIL_LIKE);
  console.log(`materialized ${reminders} reminders for ${targetDate}`);
  console.log(`seeded ${users} users in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

  const rows = await verifyPeak(sql, targetDate);
  console.log(formatVerifyRows(rows));

  const peak = rows.find((row) => row.key === 'reminders_at_peak');
  if (Number(peak?.value) !== PEAK_USER_COUNT) {
    console.error(
      `\nthe peak instant carries ${peak?.value ?? 'no'} reminders, expected ${PEAK_USER_COUNT}`,
    );
    return false;
  }
  return true;
}

function databaseUrlOrExit(): string {
  try {
    return requireLoopbackDatabaseUrl(process.env.DATABASE_URL);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (import.meta.main) {
  const sql = postgres(databaseUrlOrExit());
  let ok = false;
  try {
    ok = await seed(sql, TARGET_DATE);
  } finally {
    await sql.end();
  }
  if (!ok) process.exit(1);
}
