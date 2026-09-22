import { type Db, users } from '@peak-fanout/db';
import { and, eq, getTableColumns } from 'drizzle-orm';

import { orderedPushTokens } from './push-tokens-drizzle';
import type { UsersRepository } from './users';

export function createDrizzleUsersRepository(db: Db): UsersRepository {
  return {
    async findByEmail(email) {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      return row ?? null;
    },
    async findByEmailWithPushTokens(email) {
      // One statement: the row and its ordered tokens, the aggregate correlated on this row
      // (design.md "GET /me"). Validated against the compose Postgres like the other token reads.
      const [row] = await db
        .select({ ...getTableColumns(users), pushTokens: orderedPushTokens })
        .from(users)
        .where(eq(users.email, email))
        .limit(1);
      return row ?? null;
    },
    async upsertByEmail(email) {
      // `email` is unique; the no-op update makes `RETURNING` yield the existing row.
      const [row] = await db
        .insert(users)
        .values({ email })
        .onConflictDoUpdate({ target: users.email, set: { email } })
        .returning();
      if (!row) throw new Error('users upsert returned no row');
      return row;
    },
    async updateReminderByEmail(email, reminderTime, timezone) {
      const [row] = await db
        .update(users)
        .set({ reminderTime, timezone })
        .where(and(eq(users.email, email), eq(users.seeded, false)))
        .returning();
      return row ?? null;
    },
  };
}
