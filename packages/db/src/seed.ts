// Seeds the M1 peak: 50,000 users and one reminder each for the target date, and, since M3, the
// expressions the day's cards are picked from.
// design.md "Reminders and delivery (M1)" owns the distribution; packages/db/src/seed-plan.ts owns its numbers.
//
//   DATABASE_URL=postgres://peak:peak@localhost:5432/peak bun run db:seed
//
// Every insert is one statement over generate_series, so the row count costs round trips
// proportional to the number of segments rather than to the number of users.

import postgres from 'postgres';

import { requireLoopbackDatabaseUrl } from './seed-guard';
import {
  EXPRESSION_COUNT,
  EXPRESSION_LANG,
  EXPRESSION_LEVELS,
  PEAK_USER_COUNT,
  SEED_EMAIL_DOMAIN,
  SEED_EMAIL_PREFIX,
  readExpressionCount,
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
 * Replaces `expressions` whole: every row goes, then `EXPRESSION_COUNT` rows come back at
 * positions `1..n`, one statement over `generate_series`.
 *
 * A whole-table delete and no predicate, because the table has one writer. The application
 * never inserts, updates or deletes an expression, so every row there is this seed's, and a
 * flag like `users.seeded` — which tells a seed-written row from an application-written one —
 * would record a distinction that does not exist (design.md "Data model"). The content is the
 * rule `seedExpression` states, repeated here in SQL: original placeholder text that imitates
 * no product.
 */
async function replaceExpressions(sql: Queryable, expressionCount: number): Promise<number> {
  await sql`DELETE FROM expressions`;
  const inserted = await sql`
    INSERT INTO expressions (position, lang, text, translation, level)
    SELECT
      s.i,
      ${EXPRESSION_LANG},
      'expression ' || s.i,
      'translation ' || s.i,
      (s.i % ${EXPRESSION_LEVELS}::int) + 1
    FROM generate_series(1, ${expressionCount}::int) AS s(i)
  `;
  return inserted.count;
}

/**
 * Delete fixture-owned users and jobs inside the caller's replacement transaction.
 * Capture reminder ids through users.seeded before the cascade removes that ownership join.
 * The jobs sweep still runs AFTER the cascade: an enqueue holding a reminder lock commits
 * before the cascade can delete it, and the later sweep sees the newly committed job.
 * The captured ids also keep ordinary orphan history out of the sweep now that ordinary
 * reminders produce jobs. All steps remain set-based and roll back with the replacement.
 */
export async function deleteSeededPopulation(sql: Queryable) {
  await sql`
    CREATE TEMP TABLE seed_reminders_to_delete ON COMMIT DROP AS
    SELECT r.id FROM reminders AS r INNER JOIN users AS u ON u.id = r.user_id
    WHERE u.seeded
  `;
  const deletedUsers = await sql`DELETE FROM users WHERE seeded`;
  const deletedJobs = await sql`
    DELETE FROM jobs AS j
    WHERE j.payload->>'reminder_id' IN (SELECT id::text FROM seed_reminders_to_delete)
  `;
  return { users: deletedUsers.count, jobs: deletedJobs.count };
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
async function replaceSeededPopulation(sql: Client, targetDate: string, expressionCount: number) {
  return sql.begin(async (tx) => {
    const log: string[] = [];

    // The expressions first: independent of the peak rows and of the cascade below, and the
    // table has no other writer, so nothing here waits on a tick or a worker.
    const expressions = await replaceExpressions(tx, expressionCount);
    log.push(`replaced expressions with ${expressions} rows at positions 1..${expressions}`);

    // Capture ownership, then users before jobs: `deleteSeededPopulation` owns that ordering.
    const { users: deleted, jobs } = await deleteSeededPopulation(tx);
    log.push(
      `deleted ${deleted} previously seeded users (and their reminders) and ${jobs} jobs left without a reminder`,
    );

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

    return { users, expressions, log };
  });
}

async function seed(sql: Client, targetDate: string, expressionCount: number): Promise<boolean> {
  const startedAt = Date.now();

  const { users, expressions, log } = await replaceSeededPopulation(
    sql,
    targetDate,
    expressionCount,
  );
  for (const line of log) console.log(line);
  console.log(
    `seeded ${users} users and ${expressions} expressions in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`,
  );

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
  let expressionCount = EXPRESSION_COUNT;
  try {
    expressionCount = readExpressionCount(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const sql = postgres(databaseUrlOrExit());
  let ok: boolean;
  try {
    ok = await seed(sql, TARGET_DATE, expressionCount);
  } finally {
    await sql.end();
  }
  if (!ok) process.exit(1);
}
