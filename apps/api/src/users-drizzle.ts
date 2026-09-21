import { type Db, users } from '@peak-fanout/db';
import { and, eq, sql } from 'drizzle-orm';

import type { UsersRepository } from './users';

/**
 * `expo_push_token` after a conditional clear (design.md "DELETE /me/push-token"): NULL while
 * the column equals `token`, otherwise unchanged. One expression inside the UPDATE, so there is
 * no check-then-write window and RETURNING shows the row the statement saw; a column that is
 * already NULL falls to ELSE (NULL = $token is not true) and stays NULL.
 */
function clearedWhenEqual(token: string) {
  const column = users.expoPushToken;
  return sql<string | null>`case when ${column} = ${token} then null else ${column} end`;
}

export function createDrizzleUsersRepository(db: Db): UsersRepository {
  return {
    async findByEmail(email) {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);
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
    async updatePushTokenByEmail(email, token) {
      const [row] = await db
        .update(users)
        .set({ expoPushToken: token })
        .where(and(eq(users.email, email), eq(users.seeded, false)))
        .returning();
      return row ?? null;
    },
    async clearPushTokenByEmail(email, token) {
      const [row] = await db
        .update(users)
        .set({ expoPushToken: token === undefined ? null : clearedWhenEqual(token) })
        .where(and(eq(users.email, email), eq(users.seeded, false)))
        .returning();
      return row ?? null;
    },
  };
}
