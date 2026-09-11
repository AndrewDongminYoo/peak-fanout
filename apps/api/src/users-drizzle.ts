import { type Db, users } from '@peak-fanout/db';
import { eq } from 'drizzle-orm';

import type { UsersRepository } from './users';

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
  };
}
