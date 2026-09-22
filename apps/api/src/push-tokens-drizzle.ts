import { type Db, pushTokens, users } from '@peak-fanout/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import type { PushTokensRepository } from './push-tokens';

/**
 * A `users` row's tokens as one ordered aggregate, correlated on the `users` row of the statement
 * it is selected in (design.md "Send targets", "GET /me"): `'{}'` when the user has none. Every
 * reader that needs a user's tokens beside the user's own row selects this expression so the read
 * stays one statement — the worker's claim and the naive tick's due select for the send targets,
 * and `GET /me` for the API-p95 instrument. `(created_at, id)`: two registrations in one
 * transaction share `now()`, so the id breaks the tie, as the claim's own `ORDER BY run_at, id`
 * does. The driver parses `text[]` to `string[]`.
 *
 * The correlation names `users.id` through the table and the identifier rather than the column:
 * Drizzle drops the table qualifier from every column in a select over one table with no join, and
 * an unqualified `"id"` inside the subquery is `push_tokens.id`, which matches nothing and reads
 * `'{}'` for every user. `findByEmailWithPushTokens` is such a select; the senders' joins are not,
 * but the expression is the same in all three.
 */
const usersId = sql`${users}.${sql.identifier(users.id.name)}`;
export const orderedPushTokens = sql<string[]>`coalesce((
  select array_agg(${pushTokens.token} order by ${pushTokens.createdAt}, ${pushTokens.id})
  from ${pushTokens}
  where ${pushTokens.userId} = ${usersId}
), '{}'::text[])`;

// The SQL here is not unit-tested. It is validated against the compose Postgres before a pull
// request opens, and the pull request body carries that output (design.md "PUT /me/push-token",
// "DELETE /me/push-token").
export function createDrizzlePushTokensRepository(db: Db): PushTokensRepository {
  return {
    async listByUserId(userId) {
      // `(created_at, id)`: two registrations in one transaction share now(), so the id breaks
      // the tie, as the claim's `ORDER BY run_at, id` does (design.md "GET /me").
      const rows = await db
        .select({ token: pushTokens.token })
        .from(pushTokens)
        .where(eq(pushTokens.userId, userId))
        .orderBy(asc(pushTokens.createdAt), asc(pushTokens.id));
      return rows.map((row) => row.token);
    },
    async registerForUser(userId, token) {
      // One statement, no read before the write: the unique constraint on `token` is what the
      // conflict keys on, and `created_at = now()` makes the row read as the current
      // registration's instant whether it moved or was re-registered.
      await db
        .insert(pushTokens)
        .values({ userId, token })
        .onConflictDoUpdate({
          target: pushTokens.token,
          set: { userId: sql`excluded.user_id`, createdAt: sql`now()` },
        });
    },
    async removeForUser(userId, token) {
      await db
        .delete(pushTokens)
        .where(and(eq(pushTokens.userId, userId), eq(pushTokens.token, token)));
    },
  };
}
