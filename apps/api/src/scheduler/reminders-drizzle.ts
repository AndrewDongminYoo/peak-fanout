// `RemindersRepository` over Drizzle. The only place M1's two scheduler statements live.

import { deliveries, reminders, users, type Db } from '@peak-fanout/db';
import { and, asc, eq, lte } from 'drizzle-orm';

import type { RemindersRepository } from './tick';

export function createDrizzleRemindersRepository(db: Db): RemindersRepository {
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
  };
}
