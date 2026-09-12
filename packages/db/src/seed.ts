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
  seededEmails,
  SEED_EMAIL_PREFIX,
  seedSegments,
  TARGET_DATE,
  type SeedSegment,
} from './seed-plan';
import { formatVerifyRows, verifyPeak } from './verify-peak';

type Client = ReturnType<typeof postgres>;

/**
 * The tagged-template surface the replacement steps need.
 * A pool client and a transaction client both satisfy it, so each step runs unchanged inside
 * `sql.begin` — `TransactionSql` is not assignable to `Sql`, which owns `begin`, `end` and `listen`.
 */
type Queryable = postgres.ISql;

/**
 * Removes the rows a previous seed run wrote, and only those.
 * `emails` is the generated set, so a row a magic-link login created is never in it.
 */
async function deleteSeededUsers(sql: Queryable, emails: string[]): Promise<number> {
  const deleted = await sql`DELETE FROM users WHERE email = ANY(${emails}::text[])`;
  return deleted.count;
}

/**
 * Inserts one segment's users, giving index `i` the local time at
 * `localTimes[(i - firstIndex) % localTimes.length]` — the expression `assignSeedUser` mirrors.
 */
async function insertSegment(sql: Queryable, segment: SeedSegment): Promise<number> {
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
 * The materializer: one date plus the users at `emails` becomes one `reminders` row each,
 * at that user's local `reminder_time` converted to UTC for that date.
 *
 * The population is an explicit address set, and a parameter, because the seed may only write
 * rows its own delete can remove (design.md "Reminders and delivery (M1)").
 * Nothing in M1 materializes for the whole table, and no caller here pretends to.
 * Nothing in M1 runs this on a schedule.
 */
export async function materializeReminders(
  sql: Queryable,
  targetDate: string,
  emails: string[],
): Promise<number> {
  const inserted = await sql`
    INSERT INTO reminders (user_id, scheduled_at)
    SELECT u.id, (${targetDate}::date + u.reminder_time) AT TIME ZONE u.timezone
    FROM users AS u
    WHERE u.email = ANY(${emails}::text[])
    ON CONFLICT (user_id, scheduled_at) DO NOTHING
  `;
  return inserted.count;
}

/**
 * Deletes the seeded population and writes it again, as one transaction.
 *
 * The delete must not be able to commit on its own: a failure in a later insert would otherwise
 * leave the database with no seeded rows at all, and the next run's report would describe a
 * population nobody asked for. Every step therefore takes the transaction client.
 * The log lines are collected rather than printed, because a rolled-back attempt must not leave
 * counts on the terminal for rows that no longer exist.
 */
async function replaceSeededPopulation(sql: Client, targetDate: string) {
  const emails = seededEmails();
  return sql.begin(async (tx) => {
    const log: string[] = [];

    const deleted = await deleteSeededUsers(tx, emails);
    log.push(`deleted ${deleted} previously seeded users (and their reminders)`);

    let users = 0;
    for (const segment of seedSegments(targetDate)) {
      const inserted = await insertSegment(tx, segment);
      users += inserted;
      log.push(
        `inserted ${inserted} users in ${segment.timezone} over ${segment.localTimes.length} local time(s)`,
      );
    }

    const reminders = await materializeReminders(tx, targetDate, emails);
    log.push(`materialized ${reminders} reminders for ${targetDate}`);

    return { users, log };
  });
}

async function seed(sql: Client, targetDate: string): Promise<boolean> {
  const startedAt = Date.now();

  const { users, log } = await replaceSeededPopulation(sql, targetDate);
  for (const line of log) console.log(line);
  console.log(`seeded ${users} users in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);

  // Verification runs after the commit, deliberately outside the transaction. A failed peak
  // assertion has to leave the rows in place so a flattened peak can be inspected, and
  // `bun run db:verify-peak` reads the same query standalone; rolling back on a failed assertion
  // would delete the only evidence of why it failed.
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
