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

import { deliveries, jobs, reminders, users, type Db } from '@peak-fanout/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { DeliverySender } from '../push/sender';
import { isSendReminderJob } from '../scheduler/enqueue';
import { decideFailure, type ClaimedJob, type JobsRepository } from './loop';

/**
 * `sender` is the record both `deliveries` inserts below carry — the completion's and the
 * failure's — built by the process from the sink settings it read (design.md "Data model"). An
 * added column in an insert changes no lock order: the three rules in the header stand.
 */
export function createDrizzleJobsRepository(db: Db, sender: DeliverySender): JobsRepository {
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

      // The token the sink is handed. No `users.seeded` predicate: the job exists only because
      // the enqueue tick selected a seeded reminder (design.md "The worker").
      const tokens = await db
        .select({ reminderId: reminders.id, pushToken: users.expoPushToken })
        .from(reminders)
        .innerJoin(users, eq(users.id, reminders.userId))
        .where(
          inArray(
            reminders.id,
            targets.map((target) => target.reminderId),
          ),
        );
      const tokenByReminder = new Map(tokens.map((row) => [row.reminderId, row.pushToken]));

      return targets.map((target): ClaimedJob => ({
        ...target,
        pushToken: tokenByReminder.get(target.reminderId) ?? null,
      }));
    },

    async complete(job, latencyMs) {
      // One transaction per attempt: `deliveries.created_at` is the transaction timestamp, and the
      // fan-out duration is measured from it (design.md "The scheduler"). The job row is locked
      // first, by a statement whose only purpose is the lock — the delivery insert that follows
      // takes a key-share lock on the reminder through its foreign key, so an insert placed first
      // would touch the reminder before the job and make the file's ordering rule untrue of the
      // statement, whatever the lock modes then do (design.md "Graceful shutdown and the lease").
      return db.transaction(async (tx) => {
        await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, job.id)).for('update');
        await tx
          .insert(deliveries)
          .values({ reminderId: job.reminderId, status: 'sent', latencyMs, error: null, sender });
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

    async retryOrDeadLetter(job, failure, policy) {
      return db.transaction(async (tx) => {
        // The job row first, for the ordering rule `complete` explains, and the decision is taken
        // from that row under lock rather than from the count the claim returned: a worker that
        // fails the same reclaimed job a moment after another one waits here, then reads the
        // incremented count and decides from it (design.md "Retry, backoff, dead-letter"). The
        // failed send is written down whatever the row says; a job that is no longer open was
        // finished by another worker and is left alone.
        const [live] = await tx
          .select({ attempts: jobs.attempts, doneAt: jobs.doneAt })
          .from(jobs)
          .where(eq(jobs.id, job.id))
          .for('update');
        await tx.insert(deliveries).values({
          reminderId: job.reminderId,
          status: 'failed',
          latencyMs: failure.latencyMs,
          error: failure.error,
          sender,
        });
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
