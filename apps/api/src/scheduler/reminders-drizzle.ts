// `RemindersRepository` and `EnqueueRepository` over Drizzle: the naive send's two statements and
// the enqueue tick's one. One object serves both ticks, because the enqueue tick asks the naive
// tick's due question before it enqueues.

import { deliveries, reminders, users, type Db } from '@peak-fanout/db';
import { and, asc, eq, lte, sql } from 'drizzle-orm';

import { SEND_REMINDER_KIND, type EnqueueRepository } from './enqueue';
import type { RemindersRepository } from './tick';

export function createDrizzleRemindersRepository(db: Db): RemindersRepository & EnqueueRepository {
  return {
    async dueReminders(now) {
      // design.md "The scheduler": due and pending ordered by scheduled_at, seeded rows only.
      // Unbatched on purpose — the whole due set comes back in one statement.
      return db
        .select({
          id: reminders.id,
          scheduledAt: reminders.scheduledAt,
          pushToken: users.expoPushToken,
        })
        .from(reminders)
        .innerJoin(users, eq(users.id, reminders.userId))
        .where(
          and(
            eq(reminders.state, 'pending'),
            lte(reminders.scheduledAt, now),
            eq(users.seeded, true),
          ),
        )
        .orderBy(asc(reminders.scheduledAt));
    },

    async recordAttempt({ reminderId, status, latencyMs, error }) {
      // One transaction per attempt, and never a batch of them: `deliveries.created_at` defaults
      // to now(), which is the transaction timestamp, so a batch would stamp every row in it
      // identically and flatten the fan-out duration the run log reports.
      await db.transaction(async (tx) => {
        await tx.insert(deliveries).values({ reminderId, status, latencyMs, error });
        // `state = 'pending'` in the predicate keeps a second writer from moving a reminder
        // twice. M1 has one writer, so it is a guard rather than a claim.
        await tx
          .update(reminders)
          .set({ state: status })
          .where(and(eq(reminders.id, reminderId), eq(reminders.state, 'pending')));
      });
    },

    async enqueue(reminderIds) {
      // One statement, so one transaction: the reminders move `pending -> queued` and the jobs
      // are inserted from the rows that actually moved. `state = 'pending'` in the update is the
      // whole "nothing is enqueued twice" guarantee — a reminder another writer moved between the
      // due query and this statement is skipped here, and the count says so. The ids travel as
      // one array parameter rather than one placeholder each (design.md "The enqueue tick"):
      // `sql.param` is what keeps them one parameter, because a bare array in a `sql` template
      // is expanded into a `($1, $2, …)` tuple, which Postgres cannot cast to `uuid[]`.
      const inserted = await db.execute(sql`
        WITH queued AS (
          UPDATE reminders
          SET state = 'queued'
          WHERE id = ANY(${sql.param(reminderIds)}::uuid[]) AND state = 'pending'
          RETURNING id
        )
        INSERT INTO jobs (kind, payload, run_at, attempts)
        SELECT ${SEND_REMINDER_KIND}, jsonb_build_object('reminder_id', id), now(), 0
        FROM queued
      `);
      return inserted.count;
    },
  };
}
