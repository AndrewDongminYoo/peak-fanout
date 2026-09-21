import { Elysia, status, t } from 'elysia';

import { readBearerToken, verifySupabaseJwt, type SupabaseJwtKeys } from './auth';
import type { CardsService } from './cards/service';
import type { DeliveriesRepository, DeliveryRecord } from './deliveries';
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

const Conflict = t.Object({
  error: t.Literal('conflict'),
  reason: t.Literal('reserved_identity'),
});

const InvalidReminder = t.Object({
  error: t.Literal('validation'),
  reason: t.Union([t.Literal('invalid_reminder_time'), t.Literal('invalid_timezone')]),
});

const InvalidPushToken = t.Object({
  error: t.Literal('validation'),
  reason: t.Literal('invalid_push_token'),
});

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

// design.md "GET /cards/today": the local date the pick was made for, and its cards in position
// order — three, fewer when the table holds fewer, none when it is empty.
const Cards = t.Object({
  date: t.String(),
  cards: t.Array(
    t.Object({
      position: t.Integer(),
      lang: t.String(),
      text: t.String(),
      translation: t.String(),
      level: t.Integer(),
    }),
  ),
});

const DeliveryLog = t.Object({
  deliveries: t.Array(
    t.Object({
      id: t.String(),
      status: t.Union([t.Literal('sent'), t.Literal('failed')]),
      latency_ms: t.Integer(),
      created_at: t.String(),
    }),
  ),
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

function toDelivery(delivery: DeliveryRecord) {
  return {
    id: delivery.id,
    status: delivery.status,
    latency_ms: delivery.latencyMs,
    created_at: delivery.createdAt.toISOString(),
  };
}

function isReminderTime(value: string) {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isKnownTimezone(value: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function isExpoPushToken(value: string) {
  // Match `Expo.isExpoPushToken` without importing the server SDK into `App`, which the mobile
  // workspace imports for Eden treaty types. M5's provider sink will own that dependency.
  return (
    ((value.startsWith('ExponentPushToken[') || value.startsWith('ExpoPushToken[')) &&
      value.endsWith(']')) ||
    /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(value)
  );
}

/**
 * The two identity responses name a user, so no cache may keep them, whatever the status
 * (design.md "Authentication"). This is a `transform` hook because it is the route-scoped stage
 * that runs before the `auth` macro's `resolve`: when that returns the early 401, the route's
 * `beforeHandle`, `afterHandle` and `mapResponse` are skipped, but a header already in `set`
 * is still written.
 */
function noStore({ set }: { set: { headers: Record<string, string | number> } }) {
  set.headers['cache-control'] = 'no-store';
}

export type AppDeps = {
  users: UsersRepository;
  /** How Supabase access tokens are verified; see `verifySupabaseJwt`. */
  jwt: SupabaseJwtKeys;
  /** The day's cards for a user's timezone, through the cache; `index.ts` passes the service over `db.read`. */
  cards: Pick<CardsService, 'todayFor'>;
  /** The shared load-test delivery sample; `index.ts` passes a repository over `db.read`. */
  deliveries: DeliveriesRepository;
};

/**
 * Build the Elysia app from its dependencies. Tests pass an in-memory
 * repositories, fake cards and keys generated in the test; `index.ts` passes
 * Drizzle over the configured database URLs and the project's JWKS URL.
 */
export function createApp({ users, jwt, cards, deliveries }: AppDeps) {
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
    .post(
      '/auth/session',
      async ({ email, status }) => {
        const user = await users.upsertByEmail(email);
        // A seeded row is a load-test fixture, so it is not available as a login identity:
        // handing it back would give the caller reminders it did not create and an account the
        // next `bun run db:seed` deletes. The upsert that found it only no-op updated its email.
        if (user.seeded) {
          return status(409, { error: 'conflict', reason: 'reserved_identity' } as const);
        }
        return toSessionUser(user);
      },
      {
        auth: true,
        transform: noStore,
        response: { 200: SessionUser, 401: Unauthorized, 409: Conflict },
      },
    )
    .get(
      '/me',
      async ({ email, status }) => {
        const user = await users.findByEmail(email);
        // A seeded row reads as absent here for the same reason `POST /auth/session` refuses it.
        if (!user || user.seeded) return status(404, { error: 'not_found' } as const);
        return toMe(user);
      },
      {
        auth: true,
        transform: noStore,
        response: { 200: Me, 401: Unauthorized, 404: NotFound },
      },
    )
    .put(
      '/me/reminder',
      async ({ body, email, status }) => {
        if (!isReminderTime(body.reminder_time)) {
          return status(422, {
            error: 'validation',
            reason: 'invalid_reminder_time',
          } as const);
        }
        if (!isKnownTimezone(body.timezone)) {
          return status(422, {
            error: 'validation',
            reason: 'invalid_timezone',
          } as const);
        }
        const user = await users.updateReminderByEmail(email, body.reminder_time, body.timezone);
        if (!user) return status(404, { error: 'not_found' } as const);
        return toMe(user);
      },
      {
        auth: true,
        body: t.Object({ reminder_time: t.String(), timezone: t.String() }),
        error({ code, error }) {
          if (code !== 'VALIDATION' || error.type !== 'body') return;
          const reason = error.all.every(({ path }) => path === '/timezone')
            ? 'invalid_timezone'
            : 'invalid_reminder_time';
          return status(422, { error: 'validation', reason } as const);
        },
        response: { 200: Me, 401: Unauthorized, 404: NotFound, 422: InvalidReminder },
      },
    )
    .put(
      '/me/push-token',
      async ({ body, email, status }) => {
        if (!isExpoPushToken(body.token)) {
          return status(422, {
            error: 'validation',
            reason: 'invalid_push_token',
          } as const);
        }
        const user = await users.updatePushTokenByEmail(email, body.token);
        if (!user) return status(404, { error: 'not_found' } as const);
        return toMe(user);
      },
      {
        auth: true,
        body: t.Object({ token: t.String() }),
        error({ code, error }) {
          if (code !== 'VALIDATION' || error.type !== 'body') return;
          return status(422, {
            error: 'validation',
            reason: 'invalid_push_token',
          } as const);
        },
        response: { 200: Me, 401: Unauthorized, 404: NotFound, 422: InvalidPushToken },
      },
    )
    .delete(
      '/me/push-token',
      async ({ email, status }) => {
        // design.md "DELETE /me/push-token": the app clears the token on sign-out and before
        // another account signs into the same installation, so the worker stops sending this
        // user's reminders to a device that no longer belongs to them. No body: the row's
        // token goes to NULL, and a row that already has none is answered the same way.
        const user = await users.clearPushTokenByEmail(email);
        if (!user) return status(404, { error: 'not_found' } as const);
        return toMe(user);
      },
      {
        auth: true,
        response: { 200: Me, 401: Unauthorized, 404: NotFound },
      },
    )
    .get(
      '/cards/today',
      async ({ email, status }) => {
        // `users` is read on the primary, as `/me` reads it: a login must see its own upsert.
        // Only the cards go through `db.read` (design.md "Data model").
        const user = await users.findByEmail(email);
        if (!user || user.seeded) return status(404, { error: 'not_found' } as const);
        // "Today" is now in the user's timezone, never the UTC date (design.md "The day's cards").
        return cards.todayFor(new Date(), user.timezone);
      },
      { auth: true, response: { 200: Cards, 401: Unauthorized, 404: NotFound } },
    )
    .get(
      '/deliveries',
      async ({ email, query, status }) => {
        // Authentication proves who may inspect the demo, while `users.seeded` owns which rows
        // belong to its shared operational sample (design.md "GET /deliveries").
        const user = await users.findByEmail(email);
        if (!user || user.seeded) return status(404, { error: 'not_found' } as const);
        const rows = await deliveries.recentSeeded(query.limit ?? 20);
        return { deliveries: rows.map(toDelivery) };
      },
      {
        auth: true,
        query: t.Object({
          limit: t.Optional(t.Integer({ minimum: 1, maximum: 100 })),
        }),
        response: { 200: DeliveryLog, 401: Unauthorized, 404: NotFound },
      },
    );
}

/** What `apps/mobile` imports for Eden treaty. */
export type App = ReturnType<typeof createApp>;
