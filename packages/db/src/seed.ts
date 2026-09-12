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
 * `seeded` is false on every row the application creates, so a magic-link login is never
 * deleted here even if it holds an address this seed also generates.
 */
async function deleteSeededUsers(sql: Queryable): Promise<number> {
  const deleted = await sql`DELETE FROM users WHERE seeded`;
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
    INSERT INTO users (email, timezone, reminder_time, seeded)
    SELECT
      ${SEED_EMAIL_PREFIX} || s.i || ${SEED_EMAIL_DOMAIN},
      ${segment.timezone},
      slot.reminder_time,
      true
    FROM generate_series(${segment.firstIndex}::int, ${lastIndex}::int) AS s(i)
    JOIN slot
      ON slot.slot_position = (s.i - ${segment.firstIndex}::int) % ${segment.localTimes.length}::int
  `;
  return inserted.count;
}

/**
 * The materializer: one date plus the seeded users becomes one `reminders` row each,
 * at that user's local `reminder_time` converted to UTC for that date.
 *
 * The population is the marked rows and not a parameter, because the seed may only write rows
 * its own delete can remove (design.md "The seed owns its rows by a recorded flag, not by
 * their address"). Nothing in M1 materializes for unmarked rows.
 * Nothing in M1 runs this on a schedule.
 */
export async function materializeReminders(sql: Queryable, targetDate: string): Promise<number> {
  const inserted = await sql`
    INSERT INTO reminders (user_id, scheduled_at)
    SELECT u.id, (${targetDate}::date + u.reminder_time) AT TIME ZONE u.timezone
    FROM users AS u
    WHERE u.seeded
    ON CONFLICT (user_id, scheduled_at) DO NOTHING
  `;
  return inserted.count;
}

/**
 * Turns the one failure the `seeded` flag makes reachable into a diagnosis.
 *
 * The flag stops the seed from deleting a row the application created, which is the point of it.
 * The consequence is that a row at an address the seed also generates blocks the insert on the
 * unique index instead, and the raw `duplicate key value` error says nothing about why a seed run
 * would collide with a login. This names the address and the two ways out.
 */
export function describeEmailCollision(error: unknown): unknown {
  const pg = error as { code?: string; constraint_name?: string; detail?: string };
  if (pg?.code !== '23505' || pg.constraint_name !== 'users_email_unique') return error;
  const address = /\(email\)=\(([^)]*)\)/.exec(pg.detail ?? '')?.[1];
  return new Error(
    `refusing to seed: ${address ?? 'an address'} already belongs to a user this seed did not create, ` +
      'so the seed would have to overwrite a row it does not own. Nothing was changed. Either delete ' +
      'that user, or move the seed off the address by changing SEED_EMAIL_PREFIX or SEED_EMAIL_DOMAIN ' +
      'in packages/db/src/seed-plan.ts.',
    { cause: error },
  );
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
  return sql.begin(async (tx) => {
    const log: string[] = [];

    const deleted = await deleteSeededUsers(tx);
    log.push(`deleted ${deleted} previously seeded users (and their reminders)`);

    let users = 0;
    try {
      for (const segment of seedSegments(targetDate)) {
        const inserted = await insertSegment(tx, segment);
        users += inserted;
        log.push(
          `inserted ${inserted} users in ${segment.timezone} over ${segment.localTimes.length} local time(s)`,
        );
      }
    } catch (error) {
      throw describeEmailCollision(error);
    }

    const reminders = await materializeReminders(tx, targetDate);
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
