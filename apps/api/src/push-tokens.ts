/**
 * The `push_tokens` rows of one user, as the routes need them (design.md "Data model",
 * "PUT /me/push-token", "DELETE /me/push-token"). Database-free, like `UsersRepository`, so
 * `apps/mobile` can typecheck `type App` without the Drizzle types; `push-tokens-drizzle.ts` is
 * the implementation and `app.test.ts` keeps an in-memory one.
 */
export interface PushTokensRepository {
  /** The user's tokens ordered by `(created_at, id)`, the order `GET /me` lists; `[]` when none. */
  listByUserId(userId: string): Promise<string[]>;
  /**
   * `INSERT … ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, created_at = now()`:
   * a new row, a re-registration with a fresh `created_at`, or a move from the account that held
   * the token before, because a token names an installation and the last account to register
   * from it owns it.
   */
  registerForUser(userId: string, token: string): Promise<void>;
  /**
   * `DELETE … WHERE user_id = $userId AND token = $token`: the user's own row for that token and
   * nothing else, so a token another user holds, or nobody does, deletes nothing.
   */
  removeForUser(userId: string, token: string): Promise<void>;
}
