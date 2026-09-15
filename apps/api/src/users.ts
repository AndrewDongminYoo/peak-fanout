/**
 * One `users` row as the API sees it. Mirrors `packages/db` `User` without
 * importing it, so `apps/mobile` can typecheck `type App` without pulling
 * the Drizzle and `postgres` driver types into its program.
 */
export type UserRecord = {
  id: string;
  email: string;
  timezone: string;
  /** Postgres `time` as text, e.g. "21:00:00". */
  reminderTime: string;
  expoPushToken: string | null;
  /**
   * True only for a row `bun run db:seed` wrote (design.md "The seed owns its rows by a
   * recorded flag, not by their address"). The API never serves such a row as an identity:
   * it is a load-test fixture the next seed run deletes, not a person.
   */
  seeded: boolean;
  createdAt: Date;
};

/** The persistence the routes need. Tests use an in-memory one, `index.ts` wires Drizzle. */
export interface UsersRepository {
  findByEmail(email: string): Promise<UserRecord | null>;
  upsertByEmail(email: string): Promise<UserRecord>;
  updateReminderByEmail(
    email: string,
    reminderTime: string,
    timezone: string,
  ): Promise<UserRecord | null>;
  updatePushTokenByEmail(email: string, token: string): Promise<UserRecord | null>;
}
