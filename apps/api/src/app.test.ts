import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

import { createApp } from './app';
import type { CardsService, DayCards, ExpressionCard } from './cards/service';
import type { PushTokensRepository } from './push-tokens';
import type { UserRecord, UsersRepository } from './users';

const SECRET = 'test-jwt-secret-with-at-least-32-characters-long';
const EMAIL = 'nightowl@example.com';
const KID = 'test-signing-key';
// What `index.ts` derives from SUPABASE_URL and the `aud` Supabase Auth writes; every helper
// below signs both unless a case removes or replaces one.
const ISSUER = 'http://127.0.0.1:54321/auth/v1';
const AUDIENCE = 'authenticated';

/** `null` leaves the claim out of the token entirely; a string replaces the pinned value. */
type PinnedClaims = { iss?: string | null; aud?: string | null };

function withPinnedClaims(
  claims: Record<string, unknown>,
  { iss = ISSUER, aud = AUDIENCE }: PinnedClaims = {},
) {
  return {
    ...(iss === null ? {} : { iss }),
    ...(aud === null ? {} : { aud }),
    ...claims,
  };
}

// The Supabase CLI signs local access tokens with an ES256 key it publishes at
// /auth/v1/.well-known/jwks.json; stand in for that key set here.
let signingKey: CryptoKey;
let jwks: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('ES256');
  signingKey = pair.privateKey;
  jwks = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'ES256', use: 'sig' }],
  });
});

/** Sign a token the way the local Supabase CLI does: ES256 with a `kid`. */
function signAsymmetricToken(
  claims: Record<string, unknown>,
  kid = KID,
  key?: CryptoKey,
  pinned: PinnedClaims = {},
) {
  return new SignJWT(withPinnedClaims(claims, pinned))
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key ?? signingKey);
}

/**
 * In-memory `users`: enough to exercise the routes without Postgres. `tokens` is the
 * `push_tokens` store the Drizzle repository's one-statement read correlates on.
 */
function createMemoryUsersRepository(tokens: PushTokenRow[] = []) {
  const rows = new Map<string, UserRecord>();
  const repository = {
    async findByEmail(email: string) {
      return rows.get(email) ?? null;
    },
    async findByEmailWithPushTokens(email: string) {
      const row = rows.get(email);
      return row ? { ...row, pushTokens: orderedTokensOf(tokens, row.id) } : null;
    },
    async upsertByEmail(email: string) {
      const existing = rows.get(email);
      if (existing) return existing;
      const row: UserRecord = {
        id: crypto.randomUUID(),
        email,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        seeded: false,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      };
      rows.set(email, row);
      return row;
    },
    async updateReminderByEmail(email: string, reminderTime: string, timezone: string) {
      const row = rows.get(email);
      if (!row || row.seeded) return null;
      row.reminderTime = `${reminderTime}:00`;
      row.timezone = timezone;
      return row;
    },
  } satisfies UsersRepository;
  return { repository, rows };
}

type PushTokenRow = { id: number; userId: string; token: string; createdAt: number };

/** One user's tokens in `(created_at, id)` order: the aggregate both repositories' reads select. */
function orderedTokensOf(tokens: PushTokenRow[], userId: string) {
  return tokens
    .filter((row) => row.userId === userId)
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id)
    .map((row) => row.token);
}

/**
 * In-memory `push_tokens`, under the semantics of the Drizzle repository's statements: `token`
 * is unique across the table, so a register of a token another user holds moves it and refreshes
 * `created_at` (a ticking clock stands in for `now()`); a list is ordered by `(created_at, id)`;
 * a remove deletes only the caller's own row for that token.
 */
function createMemoryPushTokensRepository() {
  const tokens: PushTokenRow[] = [];
  let clock = 0;
  let nextId = 0;
  const repository = {
    async listByUserId(userId: string) {
      return orderedTokensOf(tokens, userId);
    },
    async registerForUser(userId: string, token: string) {
      clock += 1;
      const existing = tokens.find((row) => row.token === token);
      if (existing) {
        existing.userId = userId;
        existing.createdAt = clock;
        return;
      }
      nextId += 1;
      tokens.push({ id: nextId, userId, token, createdAt: clock });
    },
    async removeForUser(userId: string, token: string) {
      const index = tokens.findIndex((row) => row.userId === userId && row.token === token);
      if (index !== -1) tokens.splice(index, 1);
    },
  } satisfies PushTokensRepository;
  return { repository, tokens };
}

const card = (position: number): ExpressionCard => ({
  position,
  lang: 'en',
  text: `expression ${position}`,
  translation: `translation ${position}`,
  level: (position % 5) + 1,
});

/** A cards service answering with a fixed set, recording the instant and zone it was asked for. */
function fakeCards(cards: ExpressionCard[]) {
  const reads: Array<{ instant: Date; timezone: string }> = [];
  const service: Pick<CardsService, 'todayFor'> = {
    async todayFor(instant, timezone): Promise<DayCards> {
      reads.push({ instant, timezone });
      return { date: '2026-09-15', cards };
    },
  };
  return { service, reads };
}

type DeliveryFixture = {
  id: string;
  reminderId: string;
  status: 'sent' | 'failed';
  latencyMs: number;
  error: string | null;
  sender: Record<string, unknown>;
  createdAt: Date;
};

/** Seed-owned delivery rows, already in repository order, with every requested limit recorded. */
function fakeDeliveries(rows: DeliveryFixture[] = []) {
  const limits: number[] = [];
  const repository = {
    async recentSeeded(limit: number) {
      limits.push(limit);
      return rows.slice(0, limit);
    },
  };
  return { repository, limits };
}

/** Sign a token the way a legacy Supabase project does: HS256 with the project secret. */
function signToken(
  claims: Record<string, unknown>,
  {
    secret = SECRET,
    expiresIn = '1h',
    ...pinned
  }: { secret?: string; expiresIn?: string | number } & PinnedClaims = {},
) {
  return new SignJWT(withPinnedClaims(claims, pinned))
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

function request(path: string, init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, init);
}

function bearer(token: string, method = 'GET') {
  return { method, headers: { authorization: `Bearer ${token}` } };
}

function jsonPut(token: string, body: unknown): RequestInit {
  return {
    ...bearer(token, 'PUT'),
    headers: {
      ...bearer(token, 'PUT').headers,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

/** A `DELETE` carrying a JSON body: the conditional clear, or a malformed one. */
function jsonDelete(token: string, body: unknown): RequestInit {
  return { ...jsonPut(token, body), method: 'DELETE' };
}

describe('createApp', () => {
  let app: ReturnType<typeof createApp>;
  let rows: Map<string, UserRecord>;
  let tokens: PushTokenRow[];
  let cards: ReturnType<typeof fakeCards>;

  beforeEach(() => {
    const pushTokens = createMemoryPushTokensRepository();
    const memory = createMemoryUsersRepository(pushTokens.tokens);
    rows = memory.rows;
    tokens = pushTokens.tokens;
    cards = fakeCards([card(1), card(2), card(3)]);
    app = createApp({
      users: memory.repository,
      pushTokens: pushTokens.repository,
      jwt: { secret: SECRET, issuer: ISSUER, jwks },
      cards: cards.service,
      deliveries: fakeDeliveries().repository,
    });
  });

  it('does not open a port when built', () => {
    expect(app.server).toBeNull();
  });

  it('GET /health stays public', async () => {
    const response = await app.handle(request('/health'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  describe('bearer token rejection', () => {
    it('401 missing_token without an Authorization header', async () => {
      const response = await app.handle(request('/me'));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_token' });
    });

    it('401 missing_token when the header is not a Bearer token', async () => {
      const response = await app.handle(
        request('/me', { headers: { authorization: 'Basic user-and-password' } }),
      );

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_token' });
    });

    it('401 invalid_token when the signature does not match the secret', async () => {
      const token = await signToken(
        { email: EMAIL },
        { secret: 'another-secret-that-is-long-enough-too' },
      );
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });

    it('401 invalid_token for a malformed token', async () => {
      const response = await app.handle(request('/me', bearer('not-a-jwt')));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });

    it('401 invalid_token when the email claim is missing', async () => {
      const token = await signToken({ sub: 'user-id', role: 'authenticated' });
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });

    it('401 invalid_token when the token has no exp claim', async () => {
      const token = await new SignJWT(withPinnedClaims({ email: EMAIL }))
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .sign(new TextEncoder().encode(SECRET));
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });

    it('401 expired_token when exp is in the past', async () => {
      const token = await signToken(
        { email: EMAIL },
        { expiresIn: Math.floor(Date.now() / 1000) - 60 },
      );
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'expired_token' });
    });

    it('applies the same rule to POST /auth/session', async () => {
      const response = await app.handle(request('/auth/session', { method: 'POST' }));

      expect(response.status).toBe(401);
      expect(rows.size).toBe(0);
    });
  });

  describe('asymmetric (ES256) tokens from the JWKS', () => {
    it('200 when the kid is in the key set', async () => {
      const token = await signAsymmetricToken({ email: EMAIL });
      const response = await app.handle(request('/auth/session', bearer(token, 'POST')));

      expect(response.status).toBe(200);
      expect(rows.has(EMAIL)).toBe(true);
    });

    it('401 invalid_token when the kid is unknown', async () => {
      const token = await signAsymmetricToken({ email: EMAIL }, 'rotated-away');
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });

    it('401 invalid_token when signed by a different key under the same kid', async () => {
      const other = await generateKeyPair('ES256');
      const token = await signAsymmetricToken({ email: EMAIL }, KID, other.privateKey);
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });

    it('401 invalid_token when no JWKS resolver is configured', async () => {
      const secretOnly = createApp({
        users: createMemoryUsersRepository().repository,
        pushTokens: createMemoryPushTokensRepository().repository,
        jwt: { secret: SECRET, issuer: ISSUER },
        cards: fakeCards([]).service,
        deliveries: fakeDeliveries().repository,
      });
      const token = await signAsymmetricToken({ email: EMAIL });
      const response = await secretOnly.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
    });
  });

  describe('issuer and audience pinning', () => {
    // design.md "Authentication": `iss` is derived from SUPABASE_URL and `aud` is
    // `authenticated`; a token from another project, or one minted without either claim, is
    // refused before its email is read, and both signature paths get the same check.
    const signers = {
      HS256: (claims: Record<string, unknown>, pinned: PinnedClaims) => signToken(claims, pinned),
      ES256: (claims: Record<string, unknown>, pinned: PinnedClaims) =>
        signAsymmetricToken(claims, KID, undefined, pinned),
    };
    const cases: Array<[string, PinnedClaims]> = [
      ['wrong iss', { iss: 'https://other-project.supabase.co/auth/v1' }],
      ['missing iss', { iss: null }],
      ['wrong aud', { aud: 'anon' }],
      ['missing aud', { aud: null }],
    ];

    for (const [alg, sign] of Object.entries(signers)) {
      for (const [label, pinned] of cases) {
        it(`401 invalid_token for an ${alg} token with ${label}`, async () => {
          const token = await sign({ email: EMAIL }, pinned);
          const response = await app.handle(request('/auth/session', bearer(token, 'POST')));

          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({
            error: 'unauthorized',
            reason: 'invalid_token',
          });
          expect(rows.size).toBe(0);
        });
      }

      it(`200 for an ${alg} token carrying exactly the pinned iss and aud`, async () => {
        const token = await sign({ email: EMAIL }, {});
        const response = await app.handle(request('/auth/session', bearer(token, 'POST')));

        expect(response.status).toBe(200);
      });
    }

    it('still reports expired_token for an expired token carrying the pinned claims', async () => {
      // Only this intersection is asserted: jose checks `iss` and `aud` before `exp`, so an
      // expired token with a wrong or missing claim is `invalid_token`, per the table.
      const token = await signToken(
        { email: EMAIL },
        { expiresIn: Math.floor(Date.now() / 1000) - 60 },
      );
      const response = await app.handle(request('/me', bearer(token)));

      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'expired_token' });
    });
  });

  describe('identity responses are never stored by a cache', () => {
    // design.md "Authentication": `POST /auth/session` and `GET /me` carry
    // `Cache-Control: no-store` on every status, including the refusals.
    const SEEDED_EMAIL = 'load-1@example.test';

    beforeEach(() => {
      rows.set(SEEDED_EMAIL, {
        id: crypto.randomUUID(),
        email: SEEDED_EMAIL,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        seeded: true,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      });
    });

    it('on POST /auth/session: 200, 401 and 409', async () => {
      const token = await signToken({ email: EMAIL });
      const seeded = await signToken({ email: SEEDED_EMAIL });

      for (const [init, status] of [
        [bearer(token, 'POST'), 200],
        [{ method: 'POST' }, 401],
        [bearer(seeded, 'POST'), 409],
      ] as const) {
        const response = await app.handle(request('/auth/session', init));

        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    });

    it('on GET /me: 200, 401 and 404', async () => {
      const token = await signToken({ email: EMAIL });
      const seeded = await signToken({ email: SEEDED_EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      for (const [init, status] of [
        [bearer(token), 200],
        [{}, 401],
        [bearer(seeded), 404],
      ] as const) {
        const response = await app.handle(request('/me', init));

        expect(response.status).toBe(status);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    });
  });

  describe('a row the load seed owns is not a login identity', () => {
    // design.md "The seed owns its rows by a recorded flag, not by their address". The seed writes
    // `load-<index>@example.test` rows with `seeded = true`, and the one ordering the seed cannot
    // defend against on its own is seed first, login second: the upsert would find the marked row
    // and hand it back, giving the caller reminders it never created and an account the next seed
    // run deletes. So the API refuses it instead.
    const SEEDED_EMAIL = 'load-0@example.test';

    beforeEach(() => {
      rows.set(SEEDED_EMAIL, {
        id: crypto.randomUUID(),
        email: SEEDED_EMAIL,
        timezone: 'Asia/Seoul',
        reminderTime: '21:00:00',
        seeded: true,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      });
    });

    it('409 conflict from POST /auth/session, rather than adopting the row', async () => {
      const token = await signToken({ email: SEEDED_EMAIL });
      const response = await app.handle(request('/auth/session', bearer(token, 'POST')));

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: 'conflict', reason: 'reserved_identity' });
    });

    it('404 not_found from GET /me, so the row is not readable either', async () => {
      const token = await signToken({ email: SEEDED_EMAIL });
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    });

    it('404 not_found from GET /cards/today, for the same reason', async () => {
      const token = await signToken({ email: SEEDED_EMAIL });
      const response = await app.handle(request('/cards/today', bearer(token)));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(cards.reads).toEqual([]);
    });

    it('leaves the seeded row exactly as it was', async () => {
      const before = { ...rows.get(SEEDED_EMAIL)! };
      const token = await signToken({ email: SEEDED_EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(request('/me', bearer(token)));

      expect(rows.get(SEEDED_EMAIL)).toEqual(before);
    });

    it('still serves an ordinary address, so the refusal is not blanket', async () => {
      const token = await signToken({ email: EMAIL });
      const response = await app.handle(request('/auth/session', bearer(token, 'POST')));

      expect(response.status).toBe(200);
      expect(rows.get(EMAIL)?.seeded).toBe(false);
    });
  });

  describe('POST /auth/session then GET /me', () => {
    it('404 not_found on /me before the first session upsert', async () => {
      const token = await signToken({ email: EMAIL });
      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    });

    it('200 upserts the user by email and returns the row', async () => {
      const token = await signToken({ email: EMAIL });
      const response = await app.handle(request('/auth/session', bearer(token, 'POST')));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        id: rows.get(EMAIL)?.id,
        email: EMAIL,
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: [],
        created_at: '2026-09-12T00:00:00.000Z',
      });
    });

    it('200 /me after the upsert, with the design.md field names', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      tokens.push({
        id: 1,
        userId: rows.get(EMAIL)!.id,
        token: 'ExponentPushToken[abc]',
        createdAt: 1,
      });

      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: ['ExponentPushToken[abc]'],
      });
    });

    it('lists push_tokens in (created_at, id) order, so two registrations in one instant still have one order', async () => {
      // design.md "GET /me": the order both the card and the senders read; `created_at` alone is
      // not an order because two registrations in one transaction share `now()`.
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      const userId = rows.get(EMAIL)!.id;
      tokens.push(
        { id: 3, userId, token: 'ExponentPushToken[same-instant-later-id]', createdAt: 5 },
        { id: 2, userId, token: 'ExponentPushToken[same-instant-earlier-id]', createdAt: 5 },
        { id: 1, userId, token: 'ExponentPushToken[earliest]', createdAt: 4 },
        {
          id: 4,
          userId: crypto.randomUUID(),
          token: 'ExponentPushToken[someone-else]',
          createdAt: 1,
        },
      );

      const response = await app.handle(request('/me', bearer(token)));

      expect(await response.json()).toMatchObject({
        push_tokens: [
          'ExponentPushToken[earliest]',
          'ExponentPushToken[same-instant-earlier-id]',
          'ExponentPushToken[same-instant-later-id]',
        ],
      });
    });

    it('GET /me reads the row and its tokens in one repository read, never a second list', async () => {
      // design.md "GET /me": the route is the API-p95 instrument, one primary round trip per
      // request; the row-plus-aggregate read is that one statement, and `listByUserId` is the
      // write routes' second read. A regression to two reads would change the instrument
      // without changing any body, so it is watched here by call count.
      const calls: string[] = [];
      const pushTokens = createMemoryPushTokensRepository();
      const memory = createMemoryUsersRepository(pushTokens.tokens);
      const counted = createApp({
        users: {
          ...memory.repository,
          findByEmailWithPushTokens(email) {
            calls.push('findByEmailWithPushTokens');
            return memory.repository.findByEmailWithPushTokens(email);
          },
          findByEmail(email) {
            calls.push('findByEmail');
            return memory.repository.findByEmail(email);
          },
        },
        pushTokens: {
          ...pushTokens.repository,
          listByUserId(userId) {
            calls.push('listByUserId');
            return pushTokens.repository.listByUserId(userId);
          },
        },
        jwt: { secret: SECRET, issuer: ISSUER, jwks },
        cards: fakeCards([]).service,
        deliveries: fakeDeliveries().repository,
      });
      const token = await signToken({ email: EMAIL });
      await counted.handle(request('/auth/session', bearer(token, 'POST')));
      await counted.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExponentPushToken[abc]' })),
      );
      calls.length = 0;

      const response = await counted.handle(request('/me', bearer(token)));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ push_tokens: ['ExponentPushToken[abc]'] });
      expect(calls).toEqual(['findByEmailWithPushTokens']);
    });

    it('a second session for the same email keeps the same row', async () => {
      const token = await signToken({ email: EMAIL });
      const first = (await (
        await app.handle(request('/auth/session', bearer(token, 'POST')))
      ).json()) as { id: string };
      const second = (await (
        await app.handle(request('/auth/session', bearer(token, 'POST')))
      ).json()) as { id: string };

      expect(second.id).toBe(first.id);
      expect(rows.size).toBe(1);
    });
  });

  describe('M5 user setting writes', () => {
    it('updates the reminder and returns the normalized Me shape', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(
        request('/me/reminder', jsonPut(token, { reminder_time: '06:45', timezone: 'Asia/Seoul' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'Asia/Seoul',
        reminder_time: '06:45:00',
        push_tokens: [],
      });
      expect(rows.get(EMAIL)?.timezone).toBe('Asia/Seoul');
      expect(rows.get(EMAIL)?.reminderTime).toBe('06:45:00');
    });

    it('registers an Expo push token as one row and returns the Me shape listing it', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[device-token]' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: ['ExpoPushToken[device-token]'],
      });
      expect(tokens).toEqual([
        {
          id: 1,
          userId: rows.get(EMAIL)!.id,
          token: 'ExpoPushToken[device-token]',
          createdAt: 1,
        },
      ]);
    });

    it('keeps one row per installation, so a second device adds to the list instead of replacing it', async () => {
      // Issue #59: `users.expo_push_token` held one installation per account, and a later PUT
      // from a second installation replaced the first. Two installations are two rows.
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[first-device]' })),
      );

      const response = await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[second-device]' })),
      );

      expect(await response.json()).toMatchObject({
        push_tokens: ['ExpoPushToken[first-device]', 'ExpoPushToken[second-device]'],
      });
    });

    it('moves a token another account registered to this one and refreshes created_at', async () => {
      // design.md "PUT /me/push-token": the upsert conflicts on the token's uniqueness, so the
      // installation belongs to the account that last registered from it, and the refreshed
      // `created_at` puts it last in the new owner's list.
      const OTHER_EMAIL = 'dawnbird@example.com';
      const other = await signToken({ email: OTHER_EMAIL });
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(other, 'POST')));
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(other, { token: 'ExpoPushToken[shared-device]' })),
      );
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[own-device]' })),
      );

      const response = await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[shared-device]' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        push_tokens: ['ExpoPushToken[own-device]', 'ExpoPushToken[shared-device]'],
      });
      const otherMe = await app.handle(request('/me', bearer(other)));
      expect(await otherMe.json()).toMatchObject({ push_tokens: [] });
      expect(tokens).toHaveLength(2);
    });

    it('re-registering the same token refreshes created_at, so it lists last', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[first]' })),
      );
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[second]' })),
      );

      const response = await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[first]' })),
      );

      expect(await response.json()).toMatchObject({
        push_tokens: ['ExpoPushToken[second]', 'ExpoPushToken[first]'],
      });
      expect(tokens).toHaveLength(2);
    });

    it('rejects an invalid reminder time without changing the row', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(
        request('/me/reminder', jsonPut(token, { reminder_time: '24:00', timezone: 'Asia/Seoul' })),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'validation',
        reason: 'invalid_reminder_time',
      });
      expect(rows.get(EMAIL)?.reminderTime).toBe('21:00:00');
      expect(rows.get(EMAIL)?.timezone).toBe('UTC');
    });

    it('rejects an unknown timezone without changing the row', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(
        request(
          '/me/reminder',
          jsonPut(token, { reminder_time: '06:45', timezone: 'Mars/Olympus' }),
        ),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'validation',
        reason: 'invalid_timezone',
      });
      expect(rows.get(EMAIL)?.reminderTime).toBe('21:00:00');
      expect(rows.get(EMAIL)?.timezone).toBe('UTC');
    });

    it('rejects a malformed push token without writing a row', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'device-token' })),
      );

      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: 'validation',
        reason: 'invalid_push_token',
      });
      expect(tokens).toEqual([]);
    });

    it('keeps the documented validation body for missing and non-string fields', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      const before = { ...rows.get(EMAIL)! };

      for (const [path, body, reason] of [
        ['/me/reminder', null, 'invalid_reminder_time'],
        ['/me/reminder', { timezone: 'UTC' }, 'invalid_reminder_time'],
        ['/me/reminder', { reminder_time: 21, timezone: 'UTC' }, 'invalid_reminder_time'],
        ['/me/reminder', { reminder_time: '21:00' }, 'invalid_timezone'],
        ['/me/reminder', { reminder_time: '21:00', timezone: 9 }, 'invalid_timezone'],
        ['/me/push-token', {}, 'invalid_push_token'],
        ['/me/push-token', { token: 9 }, 'invalid_push_token'],
        ['/me/push-token', null, 'invalid_push_token'],
      ] as const) {
        const response = await app.handle(request(path, jsonPut(token, body)));

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({ error: 'validation', reason });
      }
      expect(rows.get(EMAIL)).toEqual(before);
      expect(tokens).toEqual([]);
    });

    it('accepts the legacy and UUID token forms supported by expo-server-sdk', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      for (const pushToken of [
        'ExponentPushToken[legacy-device-token]',
        '123e4567-e89b-12d3-a456-426614174000',
      ]) {
        const response = await app.handle(
          request('/me/push-token', jsonPut(token, { token: pushToken })),
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          push_tokens: expect.arrayContaining([pushToken]),
        });
      }
      expect(tokens.map((row) => row.token)).toEqual([
        'ExponentPushToken[legacy-device-token]',
        '123e4567-e89b-12d3-a456-426614174000',
      ]);
    });

    it('deletes this user’s own row for the token the body names and returns the rest', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[this-device]' })),
      );
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[other-device]' })),
      );

      const response = await app.handle(
        request('/me/push-token', jsonDelete(token, { token: 'ExpoPushToken[this-device]' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: ['ExpoPushToken[other-device]'],
      });
      expect(tokens.map((row) => row.token)).toEqual(['ExpoPushToken[other-device]']);
    });

    it('deletes nothing for a token another user holds, and answers 200 with the set as it is', async () => {
      // design.md "DELETE /me/push-token": no installation can erase another's registration,
      // and a token that moved to another account is that account's row now.
      const OTHER_EMAIL = 'dawnbird@example.com';
      const other = await signToken({ email: OTHER_EMAIL });
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(other, 'POST')));
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(other, { token: 'ExpoPushToken[their-device]' })),
      );
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[my-device]' })),
      );
      const before = tokens.map((row) => ({ ...row }));

      const response = await app.handle(
        request('/me/push-token', jsonDelete(token, { token: 'ExpoPushToken[their-device]' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: ['ExpoPushToken[my-device]'],
      });
      expect(tokens).toEqual(before);
    });

    it('deletes nothing for a token nobody holds, and answers 200 with the set as it is', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[my-device]' })),
      );

      const response = await app.handle(
        request('/me/push-token', jsonDelete(token, { token: 'ExpoPushToken[unknown-device]' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ push_tokens: ['ExpoPushToken[my-device]'] });
      expect(tokens).toHaveLength(1);
    });

    // What the Eden client sends for `delete(undefined, …)`: no body and no content-type.
    it('deletes nothing for a DELETE without a body or a content-type, and answers 200 with the set', async () => {
      // design.md "DELETE /me/push-token": an installation that remembers nothing cannot say
      // which row is its own, so the body-less form is a no-op rather than a clear of somebody's.
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[device-token]' })),
      );

      const response = await app.handle(
        request('/me/push-token', {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` },
        }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: ['ExpoPushToken[device-token]'],
      });
      expect(tokens.map((row) => row.token)).toEqual(['ExpoPushToken[device-token]']);
    });

    it('answers a body-less DELETE for a user with no tokens with the same empty 200 body', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(request('/me/push-token', bearer(token, 'DELETE')));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_tokens: [],
      });
    });

    // design.md "DELETE /me/push-token": the observed 422 set. Elysia's optional-body check
    // lets `{}` and `null` through the schema, so the handler must refuse them itself; only
    // a request that declared no body (no `content-type` header) is the body-less no-op form.
    it('422 for a DELETE body that is not { token } with a valid token, and does not write', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[device-token]' })),
      );
      const before = tokens.map((row) => ({ ...row }));

      for (const body of [
        {},
        null,
        { token: 9 },
        { other: 1 },
        { token: 'device-token' },
        'ExpoPushToken[device-token]',
      ]) {
        const response = await app.handle(request('/me/push-token', jsonDelete(token, body)));

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          error: 'validation',
          reason: 'invalid_push_token',
        });
      }
      expect(tokens).toEqual(before);
    });

    // design.md "DELETE /me/push-token": Elysia's optional JSON parser swallows a parse
    // failure, so these reach the handler with `body === undefined` exactly like a request
    // that sent nothing. The `content-type` header is what tells them apart: a request that
    // declared a body it could not deliver is told so, not answered with the no-op.
    it('422 for a DELETE that declares a body the parser could not read, and does not write', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[other-device]' })),
      );
      const before = tokens.map((row) => ({ ...row }));

      for (const [contentType, body] of [
        ['application/json', '{not json'],
        ['application/json', ''],
        ['application/json', undefined],
        ['text/plain', ''],
        ['text/plain', undefined],
      ] as const) {
        const response = await app.handle(
          request('/me/push-token', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
            body,
          }),
        );

        expect(response.status).toBe(422);
        expect(await response.json()).toEqual({
          error: 'validation',
          reason: 'invalid_push_token',
        });
      }
      expect(tokens).toEqual(before);
    });

    it('404 from a conditional clear before the first upsert and for a seed-owned row', async () => {
      const seededEmail = 'load-0@example.test';
      const seeded = {
        id: crypto.randomUUID(),
        email: seededEmail,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        seeded: true,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      } satisfies UserRecord;
      rows.set(seededEmail, seeded);
      tokens.push({
        id: 1,
        userId: seeded.id,
        token: 'ExpoPushToken[seeded-device]',
        createdAt: 1,
      });
      const before = tokens.map((row) => ({ ...row }));

      for (const email of [EMAIL, seededEmail]) {
        const token = await signToken({ email });
        const response = await app.handle(
          request('/me/push-token', jsonDelete(token, { token: 'ExpoPushToken[seeded-device]' })),
        );

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
      expect(rows.get(EMAIL)).toBeUndefined();
      expect(tokens).toEqual(before);
    });

    it('401 for DELETE /me/push-token without a bearer token', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[device-token]' })),
      );

      const response = await app.handle(request('/me/push-token', { method: 'DELETE' }));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_token' });
      expect(tokens.map((row) => row.token)).toEqual(['ExpoPushToken[device-token]']);
    });

    it('404 from DELETE /me/push-token before the first session upsert', async () => {
      const token = await signToken({ email: EMAIL });

      const response = await app.handle(request('/me/push-token', bearer(token, 'DELETE')));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(rows.size).toBe(0);
    });

    it('does not read or change a seed-owned row’s tokens through DELETE /me/push-token', async () => {
      const seededEmail = 'load-0@example.test';
      const seeded = {
        id: crypto.randomUUID(),
        email: seededEmail,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        seeded: true,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      } satisfies UserRecord;
      rows.set(seededEmail, seeded);
      tokens.push({
        id: 1,
        userId: seeded.id,
        token: 'ExpoPushToken[seeded-device]',
        createdAt: 1,
      });
      const before = tokens.map((row) => ({ ...row }));
      const token = await signToken({ email: seededEmail });

      const response = await app.handle(request('/me/push-token', bearer(token, 'DELETE')));

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
      expect(tokens).toEqual(before);
    });

    it('does not expose or change a seed-owned row through either write route', async () => {
      const seededEmail = 'load-0@example.test';
      const seeded = {
        id: crypto.randomUUID(),
        email: seededEmail,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        seeded: true,
        createdAt: new Date('2026-09-12T00:00:00.000Z'),
      } satisfies UserRecord;
      rows.set(seededEmail, seeded);
      const before = { ...seeded };
      const token = await signToken({ email: seededEmail });

      for (const [path, body] of [
        ['/me/reminder', { reminder_time: '06:45', timezone: 'Asia/Seoul' }],
        ['/me/push-token', { token: 'ExpoPushToken[device-token]' }],
      ] as const) {
        const response = await app.handle(request(path, jsonPut(token, body)));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
      expect(rows.get(seededEmail)).toEqual(before);
      expect(tokens).toEqual([]);
    });

    it('returns not_found from both write routes before the first session upsert', async () => {
      const token = await signToken({ email: EMAIL });

      for (const [path, body] of [
        ['/me/reminder', { reminder_time: '06:45', timezone: 'Asia/Seoul' }],
        ['/me/push-token', { token: 'ExpoPushToken[device-token]' }],
      ] as const) {
        const response = await app.handle(request(path, jsonPut(token, body)));

        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'not_found' });
      }
      expect(rows.size).toBe(0);
      expect(tokens).toEqual([]);
    });
  });
});

describe('GET /cards/today', () => {
  // design.md "GET /cards/today": the day's cards for the user's timezone, through the cache.
  let app: ReturnType<typeof createApp>;
  let rows: Map<string, UserRecord>;

  async function signedInUser(timezone = 'UTC') {
    const token = await signToken({ email: EMAIL });
    await app.handle(request('/auth/session', bearer(token, 'POST')));
    rows.get(EMAIL)!.timezone = timezone;
    return token;
  }

  it('401 without a token, as every authenticated route', async () => {
    app = createApp({
      users: createMemoryUsersRepository().repository,
      pushTokens: createMemoryPushTokensRepository().repository,
      jwt: { secret: SECRET, issuer: ISSUER, jwks },
      cards: fakeCards([card(1)]).service,
      deliveries: fakeDeliveries().repository,
    });
    const response = await app.handle(request('/cards/today'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_token' });
  });

  it('404 not_found before the first session upsert, as /me', async () => {
    const cards = fakeCards([card(1)]);
    app = createApp({
      users: createMemoryUsersRepository().repository,
      pushTokens: createMemoryPushTokensRepository().repository,
      jwt: { secret: SECRET, issuer: ISSUER, jwks },
      cards: cards.service,
      deliveries: fakeDeliveries().repository,
    });
    const token = await signToken({ email: EMAIL });
    const response = await app.handle(request('/cards/today', bearer(token)));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(cards.reads).toEqual([]);
  });

  it('200 with the date and three cards in the design.md shape', async () => {
    const cards = fakeCards([card(1), card(2), card(3)]);
    const memory = createMemoryUsersRepository();
    rows = memory.rows;
    app = createApp({
      users: memory.repository,
      pushTokens: createMemoryPushTokensRepository().repository,
      jwt: { secret: SECRET, issuer: ISSUER, jwks },
      cards: cards.service,
      deliveries: fakeDeliveries().repository,
    });
    const before = Date.now();
    const token = await signedInUser('America/New_York');

    const response = await app.handle(request('/cards/today', bearer(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      date: '2026-09-15',
      cards: [
        { position: 1, lang: 'en', text: 'expression 1', translation: 'translation 1', level: 2 },
        { position: 2, lang: 'en', text: 'expression 2', translation: 'translation 2', level: 3 },
        { position: 3, lang: 'en', text: 'expression 3', translation: 'translation 3', level: 4 },
      ],
    });
    // The service was asked for now, in the user's own timezone, not in UTC.
    expect(cards.reads).toHaveLength(1);
    expect(cards.reads[0]?.timezone).toBe('America/New_York');
    expect(cards.reads[0]?.instant.getTime()).toBeGreaterThanOrEqual(before);
    expect(cards.reads[0]?.instant.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('200 with an empty list when the table holds no expressions: the seed has not run', async () => {
    const cards = fakeCards([]);
    const memory = createMemoryUsersRepository();
    rows = memory.rows;
    app = createApp({
      users: memory.repository,
      pushTokens: createMemoryPushTokensRepository().repository,
      jwt: { secret: SECRET, issuer: ISSUER, jwks },
      cards: cards.service,
      deliveries: fakeDeliveries().repository,
    });
    const token = await signedInUser();

    const response = await app.handle(request('/cards/today', bearer(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ date: '2026-09-15', cards: [] });
  });
});

describe('GET /deliveries', () => {
  const first: DeliveryFixture = {
    id: '00000000-0000-4000-8000-000000000002',
    reminderId: 'private-reminder-2',
    status: 'failed',
    latencyMs: 87,
    error: 'private provider error',
    sender: { kind: 'worker', private: true },
    createdAt: new Date('2026-09-14T10:00:01.000Z'),
  };
  const second: DeliveryFixture = {
    id: '00000000-0000-4000-8000-000000000001',
    reminderId: 'private-reminder-1',
    status: 'sent',
    latencyMs: 42,
    error: null,
    sender: { kind: 'naive', private: true },
    createdAt: new Date('2026-09-14T10:00:00.000Z'),
  };

  function buildApp(deliveryRows: DeliveryFixture[] = [first, second]) {
    const memory = createMemoryUsersRepository();
    const deliveryLog = fakeDeliveries(deliveryRows);
    const app = createApp({
      users: memory.repository,
      pushTokens: createMemoryPushTokensRepository().repository,
      jwt: { secret: SECRET, issuer: ISSUER, jwks },
      cards: fakeCards([]).service,
      deliveries: deliveryLog.repository,
    });
    return { app, memory, deliveryLog };
  }

  async function signIn(app: ReturnType<typeof createApp>) {
    const token = await signToken({ email: EMAIL });
    await app.handle(request('/auth/session', bearer(token, 'POST')));
    return token;
  }

  it('401 without a token and does not read the delivery log', async () => {
    const { app, deliveryLog } = buildApp();

    const response = await app.handle(request('/deliveries'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_token' });
    expect(deliveryLog.limits).toEqual([]);
  });

  it('404 before the first session upsert and does not read the delivery log', async () => {
    const { app, deliveryLog } = buildApp();
    const token = await signToken({ email: EMAIL });

    const response = await app.handle(request('/deliveries', bearer(token)));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(deliveryLog.limits).toEqual([]);
  });

  it('404 for a seeded identity and does not read the delivery log', async () => {
    const { app, memory, deliveryLog } = buildApp();
    const seededEmail = 'load-0@example.test';
    memory.rows.set(seededEmail, {
      id: crypto.randomUUID(),
      email: seededEmail,
      timezone: 'Asia/Seoul',
      reminderTime: '21:00:00',
      seeded: true,
      createdAt: new Date('2026-09-12T00:00:00.000Z'),
    });
    const token = await signToken({ email: seededEmail });

    const response = await app.handle(request('/deliveries', bearer(token)));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
    expect(deliveryLog.limits).toEqual([]);
  });

  it('uses limit 20 by default and exposes only the public delivery fields', async () => {
    const { app, deliveryLog } = buildApp();
    const token = await signIn(app);

    const response = await app.handle(request('/deliveries', bearer(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deliveries: [
        {
          id: first.id,
          status: 'failed',
          latency_ms: 87,
          created_at: '2026-09-14T10:00:01.000Z',
        },
        {
          id: second.id,
          status: 'sent',
          latency_ms: 42,
          created_at: '2026-09-14T10:00:00.000Z',
        },
      ],
    });
    expect(deliveryLog.limits).toEqual([20]);
  });

  it('passes an explicit limit to the repository', async () => {
    const { app, deliveryLog } = buildApp();
    const token = await signIn(app);

    const response = await app.handle(request('/deliveries?limit=1', bearer(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      deliveries: [
        {
          id: first.id,
          status: 'failed',
          latency_ms: 87,
          created_at: '2026-09-14T10:00:01.000Z',
        },
      ],
    });
    expect(deliveryLog.limits).toEqual([1]);
  });

  it('200 with an empty list when no seeded delivery has been recorded', async () => {
    const { app, deliveryLog } = buildApp([]);
    const token = await signIn(app);

    const response = await app.handle(request('/deliveries', bearer(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deliveries: [] });
    expect(deliveryLog.limits).toEqual([20]);
  });

  for (const invalidLimit of ['0', '101', '1.5', 'abc']) {
    it(`422 for invalid limit ${invalidLimit} without reading the delivery log`, async () => {
      const { app, deliveryLog } = buildApp();
      const token = await signIn(app);

      const response = await app.handle(
        request(`/deliveries?limit=${invalidLimit}`, bearer(token)),
      );

      expect(response.status).toBe(422);
      expect(deliveryLog.limits).toEqual([]);
    });
  }
});
