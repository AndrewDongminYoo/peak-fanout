// The public delivery log reads only load-seed-owned rows from `db.read`.
// This SQL is validated against the compose primary and replica before a pull request opens.

import { deliveries, reminders, users, type Db } from '@peak-fanout/db';
import { desc, eq } from 'drizzle-orm';

import type { DeliveriesRepository } from './deliveries';

export function createDrizzleDeliveriesRepository(db: Db): DeliveriesRepository {
  return {
    recentSeeded(limit) {
      return db
        .select({
          id: deliveries.id,
          status: deliveries.status,
          latencyMs: deliveries.latencyMs,
          createdAt: deliveries.createdAt,
        })
        .from(deliveries)
        .innerJoin(reminders, eq(deliveries.reminderId, reminders.id))
        .innerJoin(users, eq(reminders.userId, users.id))
        .where(eq(users.seeded, true))
        .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
        .limit(limit);
    },
  };
}
