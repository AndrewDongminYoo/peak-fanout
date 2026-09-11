import { Elysia, status, t } from 'elysia';

import { readBearerToken, verifySupabaseJwt, type SupabaseJwtKeys } from './auth';
import type { UserRecord, UsersRepository } from './users';

// Response shapes from design.md "API surface". Declared as schemas so Eden
// treaty types `data` and `error` on the client.
const Unauthorized = t.Object({
  error: t.Literal('unauthorized'),
  reason: t.Union([
    t.Literal('missing_token'),
    t.Literal('invalid_token'),
    t.Literal('expired_token'),
  ]),
});

const NotFound = t.Object({ error: t.Literal('not_found') });

const Me = t.Object({
  timezone: t.String(),
  reminder_time: t.String(),
  push_token: t.Nullable(t.String()),
});

const SessionUser = t.Object({
  id: t.String(),
  email: t.String(),
  ...Me.properties,
  created_at: t.String(),
});

function toMe(user: UserRecord) {
  return {
    timezone: user.timezone,
    reminder_time: user.reminderTime,
    push_token: user.expoPushToken,
  };
}

function toSessionUser(user: UserRecord) {
  return {
    id: user.id,
    email: user.email,
    ...toMe(user),
    created_at: user.createdAt.toISOString(),
  };
}

export type AppDeps = {
  users: UsersRepository;
  /** How Supabase access tokens are verified; see `verifySupabaseJwt`. */
  jwt: SupabaseJwtKeys;
};

/**
 * Build the Elysia app from its dependencies. Tests pass an in-memory
 * repository and keys generated in the test; `index.ts` passes Drizzle over
 * `DATABASE_URL` and the project's JWKS URL.
 */
export function createApp({ users, jwt }: AppDeps) {
  return new Elysia()
    .get('/health', () => ({ ok: true }))
    .macro({
      // `auth: true` on a route rejects a missing or bad bearer token with 401
      // and exposes the verified `email` claim to the handler.
      auth: {
        async resolve({ headers }) {
          const token = readBearerToken(headers.authorization);
          if (!token) {
            return status(401, { error: 'unauthorized', reason: 'missing_token' } as const);
          }
          const verified = await verifySupabaseJwt(token, jwt);
          if (!verified.ok) {
            return status(401, { error: 'unauthorized', reason: verified.reason } as const);
          }
          return { email: verified.email };
        },
      },
    })
    .post('/auth/session', async ({ email }) => toSessionUser(await users.upsertByEmail(email)), {
      auth: true,
      response: { 200: SessionUser, 401: Unauthorized },
    })
    .get(
      '/me',
      async ({ email, status }) => {
        const user = await users.findByEmail(email);
        if (!user) return status(404, { error: 'not_found' } as const);
        return toMe(user);
      },
      { auth: true, response: { 200: Me, 401: Unauthorized, 404: NotFound } },
    );
}

/** What `apps/mobile` imports for Eden treaty. */
export type App = ReturnType<typeof createApp>;
