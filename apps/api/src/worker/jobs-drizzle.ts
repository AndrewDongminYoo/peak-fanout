// `JobsRepository` over Drizzle: the claim statement from design.md "Data model", the completion,
// and the retry and dead-letter paths. Three rules hold here (design.md "Graceful shutdown and the
// lease"). Every reminder update carries `state = 'queued'` and every job update `done_at IS
// NULL`, which is what makes a second completion after a lease reclaim harmless. Every transaction
// that touches both tables takes the job row before the reminder row, so two workers recording the
// same reclaimed job wait on each other and never deadlock. Every timestamp is the database's
// `now()`, so N workers on N clocks compare against one.
//
// The SQL here is not unit-tested. It is validated against the compose Postgres before a pull
// request opens, and the pull request body carries that output.

import { jobs, reminders, users, type Db } from '@peak-fanout/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { recordWorkerSends } from '../push/record-receipts-drizzle';
import type { DeliverySender } from '../push/sender';
import { orderedPushRegistrations, orderedPushTokens } from '../push-tokens-drizzle';
import { isSendReminderJob } from '../scheduler/enqueue';
import {
  decideFailure,
  firstFailure,
  type ClaimedJob,
  type ClaimedReminder,
  type JobsRepository,
} from './loop';

/**
 * `sender` is the record both `deliveries` inserts below carry — the completion's and the
 * failure's — built by the process from the sink settings it read (design.md "Data model"). An
 * added column in an insert changes no lock order: the three rules in the header stand.
 */
export function createDrizzleJobsRepository(
  db: Db,
  sender: DeliverySender,
  { seededOnly = false }: { seededOnly?: boolean } = {},
): JobsRepository {
  return {
    async claim(batchSize, workerId, leaseMs) {
      // The statement in design.md "Data model", written out because its shape is the point.
      // Open (`done_at IS NULL`), due (`run_at <= now()`), and either unclaimed or held by a lock
      // older than the lease; the parentheses around the lease disjunction are load-bearing,
      // since without them a stale lock would also claim done and dead-lettered rows. The
      // selection is a MATERIALIZED CTE and not `WHERE id IN (SELECT … LIMIT n …)`: Postgres
      // plans the subquery form as a semi-join that re-runs the select per candidate row, and
      // with every job of a peak on the same `run_at` each re-run breaks the tie differently, so
      // `LIMIT 2` over five tied rows updated all five on the compose Postgres. Evaluated once,
      // the batch is `batchSize` rows; `id` breaks ties so two claims see one order.
      const claimed = (await db.execute(sql`
        WITH claimed AS MATERIALIZED (
          SELECT id FROM jobs
          WHERE run_at <= now() AND done_at IS NULL
            AND (locked_at IS NULL OR locked_at < now() - (${sql.param(leaseMs)}::int * interval '1 millisecond'))
            ${
              seededOnly
                ? sql`AND EXISTS (
              SELECT 1 FROM reminders AS r INNER JOIN users AS u ON u.id = r.user_id
              WHERE r.id = (jobs.payload->>'reminder_id')::uuid AND u.seeded = true
            )`
                : sql``
            }
          ORDER BY run_at, id LIMIT ${sql.param(batchSize)}::int
          FOR UPDATE SKIP LOCKED
        )
        UPDATE jobs SET locked_at = now(), locked_by = ${sql.param(workerId)}
        FROM claimed WHERE jobs.id = claimed.id AND jobs.done_at IS NULL
        RETURNING jobs.id, jobs.kind, jobs.payload
      `)) as unknown as { id: string; kind: string; payload: unknown }[];
      if (claimed.length === 0) return [];

      const targets = claimed.map((row) => {
        // One writer (the enqueue tick) and one kind, so a row that does not parse is a bug to
        // report by id, not a job to guess at.
        if (!isSendReminderJob(row)) {
          throw new Error(
            `job ${row.id} is not a send_reminder job this worker can run (kind "${row.kind}")`,
          );
        }
        return { id: row.id, reminderId: row.payload.reminder_id };
      });

      // Ordinary reminders carry their saved local day; fixtures retain timezone + instant.
      // The ownership flag distinguishes simulated null targets from ordinary no-device skips.
      const rows = await db
        .select({
          reminderId: reminders.id,
          pushTokens: orderedPushTokens,
          seeded: users.seeded,
          localDate: reminders.localDate,
          timezone: sql<string>`coalesce(${reminders.scheduledTimezone}, ${users.timezone})`,
          ...(sender.sink.kind === 'expo' ? { pushRegistrations: orderedPushRegistrations } : {}),
          scheduledAt: reminders.scheduledAt,
        })
        .from(reminders)
        .innerJoin(users, eq(users.id, reminders.userId))
        .where(
          inArray(
            reminders.id,
            targets.map((target) => target.reminderId),
          ),
        );
      const rowByReminder = new Map(
        rows.map(({ reminderId, ...reminder }): [string, ClaimedReminder] => [
          reminderId,
          reminder,
        ]),
      );

      // A job whose reminder is gone — the orphan a re-seed's sweep removes (design.md "The
      // enqueue tick") — is handed to the loop with `reminder: null`, and the loop skips it by
      // name. It is not thrown here: the UPDATE above has already committed, so a throw at this
      // point would leave the whole batch locked in this worker's name and exit the process
      // before any of it was sent, for one row that a skip holds to one job.
      return targets.map((target): ClaimedJob => ({
        ...target,
        reminder: rowByReminder.get(target.reminderId) ?? null,
      }));
    },

    async skipNoTarget(job) {
      return db.transaction(async (tx) => {
        // Same job-before-reminder order and completion guards as an attempted send. No send
        // happened, so no delivery is inserted and attempts/dead_at/last_error stay untouched.
        const [live] = await tx
          .select({ doneAt: jobs.doneAt })
          .from(jobs)
          .where(eq(jobs.id, job.id))
          .for('update');
        if (!live || live.doneAt !== null) return 'reminder_not_queued';
        await tx
          .update(jobs)
          .set({ doneAt: sql`now()` })
          .where(and(eq(jobs.id, job.id), isNull(jobs.doneAt)));
        const moved = await tx
          .update(reminders)
          .set({ state: 'skipped' })
          .where(and(eq(reminders.id, job.reminderId), eq(reminders.state, 'queued')))
          .returning({ id: reminders.id });
        return moved.length === 1 ? 'recorded' : 'reminder_not_queued';
      });
    },

    async complete(job, sends) {
      // One transaction per attempt: `deliveries.created_at` is the transaction timestamp, and the
      // fan-out duration is measured from it (design.md "The scheduler"). The job row is locked
      // first, by a statement whose only purpose is the lock — the delivery insert that follows
      // takes a key-share lock on the reminder through its foreign key, so an insert placed first
      // would touch the reminder before the job and make the file's ordering rule untrue of the
      // statement, whatever the lock modes then do (design.md "Graceful shutdown and the lease").
      // One `sent` row per send, each with its own cost (design.md "Send targets"); the seeded
      // population has one target, so this is one row in every measured run.
      return db.transaction(async (tx) => {
        await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id)).for('update');
        await recordWorkerSends(
          tx,
          job.reminderId,
          sends.map((send) => ({ ...send, status: 'sent' })),
          sender,
        );
        await tx
          .update(jobs)
          .set({ doneAt: sql`now()` })
          .where(and(eq(jobs.id, job.id), isNull(jobs.doneAt)));
        const moved = await tx
          .update(reminders)
          .set({ state: 'sent' })
          .where(and(eq(reminders.id, job.reminderId), eq(reminders.state, 'queued')))
          .returning({ id: reminders.id });
        return moved.length === 1 ? 'recorded' : 'reminder_not_queued';
      });
    },

    async retryOrDeadLetter(job, outcomes, policy) {
      const failure = firstFailure(outcomes);
      return db.transaction(async (tx) => {
        // The job row first, for the ordering rule `complete` explains, and the decision is taken
        // from that row under lock rather than from the count the claim returned: a worker that
        // fails the same reclaimed job a moment after another one waits here, then reads the
        // incremented count and decides from it (design.md "Retry, backoff, dead-letter"). Every
        // send of the attempt is written down whatever the row says, the ones that succeeded
        // included, one row each; a job that is no longer open was finished by another worker
        // and is left alone.
        const [live] = await tx
          .select({ attempts: jobs.attempts, doneAt: jobs.doneAt })
          .from(jobs)
          .where(eq(jobs.id, job.id))
          .for('update');
        await recordWorkerSends(tx, job.reminderId, outcomes, sender);
        if (!live || live.doneAt !== null) return 'job_done';
        const outcome = decideFailure(live.attempts, policy);
        if (outcome.kind === 'retry') {
          // Released for any worker to take once run_at arrives.
          await tx
            .update(jobs)
            .set({
              attempts: outcome.attempts,
              lastError: failure.error,
              runAt: sql`now() + (${outcome.backoffMs}::int * interval '1 millisecond')`,
              lockedAt: null,
            })
            .where(and(eq(jobs.id, job.id), isNull(jobs.doneAt)));
          return 'retry';
        }
        await tx
          .update(jobs)
          .set({
            attempts: outcome.attempts,
            lastError: failure.error,
            deadAt: sql`now()`,
            doneAt: sql`now()`,
          })
          .where(and(eq(jobs.id, job.id), isNull(jobs.doneAt)));
        await tx
          .update(reminders)
          .set({ state: 'failed' })
          .where(and(eq(reminders.id, job.reminderId), eq(reminders.state, 'queued')));
        return 'dead_letter';
      });
    },
  };
}
