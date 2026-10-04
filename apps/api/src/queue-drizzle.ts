import { jobs, reminders, users, type Db } from '@peak-fanout/db';
import { and, eq, sql } from 'drizzle-orm';

import type { QueueRepository } from './queue';

export function createDrizzleQueueRepository(
  db: Pick<Db, 'select'>,
  leaseMs: number,
): QueueRepository {
  // The worker reclaims strictly older locks; equality still holds a live lease. All counts
  // share database now() and one primary statement (design.md "GET /admin/queue").
  const staleBefore = sql`now() - (${leaseMs}::int * interval '1 millisecond')`;
  return {
    async snapshotSeeded() {
      const [snapshot] = await db
        .select({
          waiting: sql<number>`count(*) FILTER (WHERE ${jobs.doneAt} IS NULL AND
            (${jobs.lockedAt} IS NULL OR ${jobs.lockedAt} < ${staleBefore}))`.mapWith(Number),
          running: sql<number>`count(*) FILTER (WHERE ${jobs.doneAt} IS NULL AND
            ${jobs.lockedAt} >= ${staleBefore})`.mapWith(Number),
          failed: sql<number>`count(*) FILTER (WHERE ${jobs.deadAt} IS NOT NULL)`.mapWith(Number),
        })
        .from(jobs)
        // Compare the payload's text to the existing reminder's id without casting arbitrary
        // payloads to uuid; an orphan or malformed reference cannot own a seeded reminder.
        .innerJoin(reminders, sql`${jobs.payload}->>'reminder_id' = ${reminders.id}::text`)
        .innerJoin(users, eq(reminders.userId, users.id))
        .where(and(eq(jobs.kind, 'send_reminder'), eq(users.seeded, true)));
      // An aggregate without GROUP BY always returns one row, including an empty queue.
      return snapshot!;
    },
  };
}
