import { Elysia, status, t } from 'elysia';

import { readBearerToken, verifySupabaseJwt, type SupabaseJwtKeys } from './auth';
import type { CardsService } from './cards/service';
import type { DeliveriesRepository, DeliveryRecord } from './deliveries';
import type { PushTokensRepository } from './push-tokens';
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

// design.md "GET /me": `push_tokens` is every registered installation's token in `(created_at,
// id)` order, `[]` when none; there is no single `push_token`, because one value cannot say which
// installation it names.
const Me = t.Object({
  timezone: t.String(),
  reminder_time: t.String(),
  push_tokens: t.Array(t.String()),
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

function toMe(user: UserRecord, pushTokens: string[]) {
  return {
    timezone: user.timezone,
    reminder_time: user.reminderTime,
    push_tokens: pushTokens,
  };
}

function toSessionUser(user: UserRecord, pushTokens: string[]) {
  return {
    id: user.id,
    email: user.email,
    ...toMe(user, pushTokens),
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
 * The token a `DELETE /me/push-token` body names, or `null` for any body that is not
 * `{ token }` with a valid Expo push token. Elysia checks an optional body schema only when
 * the body is a non-empty object, so `{}`, `null` and a non-object body reach the handler
 * despite the schema's type, and its optional JSON parser swallows a parse failure, so an
 * empty or malformed body under a JSON `content-type` arrives as `undefined` like a body
 * that was never sent. Only a request that declared no body (no `content-type` header) is
 * the body-less no-op form; everything else must carry a token, so a client that lost or
 * garbled the token it meant to send is told so instead of being answered with a no-op it
 * would read as a clear (design.md "DELETE /me/push-token").
 */
function pushTokenToClear(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || !('token' in body)) return null;
  const { token } = body;
  return typeof token === 'string' && isExpoPushToken(token) ? token : null;
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
  /** The per-installation token rows the Me routes list, register and delete; `index.ts` wires Drizzle over `db.write`. */
  pushTokens: PushTokensRepository;
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
export function createApp({ users, pushTokens, jwt, cards, deliveries }: AppDeps) {
  // Every `Me`-shaped answer to a write reads the row set after that write, so the body is the
  // set as the server now holds it (design.md "GET /me"); `GET /me` itself reads row and set in
  // one statement below.
  const meFor = async (user: UserRecord) => toMe(user, await pushTokens.listByUserId(user.id));

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
        return toSessionUser(user, await pushTokens.listByUserId(user.id));
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
        // One statement, row and tokens together: this route is the API-p95 instrument, hit at a
        // fixed rate through every measured fan-out, so it keeps the one primary round trip it
        // has had since M0 (design.md "GET /me"). The write routes below answer with the same
        // shape from a second read after their write, and none of them is measured.
        const user = await users.findByEmailWithPushTokens(email);
        // A seeded row reads as absent here for the same reason `POST /auth/session` refuses it.
        if (!user || user.seeded) return status(404, { error: 'not_found' } as const);
        return toMe(user, user.pushTokens);
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
        return meFor(user);
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
        // design.md "PUT /me/push-token": one upsert on the token's uniqueness, so the row is
        // created, re-registered with a fresh `created_at`, or moved here from the account that
        // held it. A seeded row reads as absent, as every write route has it.
        const user = await users.findByEmail(email);
        if (!user || user.seeded) return status(404, { error: 'not_found' } as const);
        await pushTokens.registerForUser(user.id, body.token);
        return meFor(user);
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
      async ({ body, email, request, status }) => {
        // design.md "DELETE /me/push-token": the app clears the token on sign-out and before
        // another account signs into the same installation, so the worker stops sending this
        // user's reminders to a device that no longer belongs to them. With `{ token }`: this
        // user's row for that token is deleted and no other, so a token another user holds, or
        // nobody does, deletes nothing. No body: nothing is deleted, because the route cannot
        // know which installation is asking; the body is the row set as it now is either way.
        // "No body" is read from the request, not from the parser: a `content-type` header
        // means the client declared one, and a body Elysia could not parse arrives as
        // `undefined` too.
        let token: string | undefined;
        if (body !== undefined || request.headers.has('content-type')) {
          const named = pushTokenToClear(body);
          if (named === null) {
            return status(422, {
              error: 'validation',
              reason: 'invalid_push_token',
            } as const);
          }
          token = named;
        }
        const user = await users.findByEmail(email);
        if (!user || user.seeded) return status(404, { error: 'not_found' } as const);
        if (token !== undefined) await pushTokens.removeForUser(user.id, token);
        return meFor(user);
      },
      {
        auth: true,
        body: t.Optional(t.Object({ token: t.String() })),
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
