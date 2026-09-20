import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

import { createApp } from './app';
import type { CardsService, DayCards, ExpressionCard } from './cards/service';
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

/** In-memory `users`: enough to exercise the routes without Postgres. */
function createMemoryUsersRepository() {
  const rows = new Map<string, UserRecord>();
  const repository = {
    async findByEmail(email: string) {
      return rows.get(email) ?? null;
    },
    async upsertByEmail(email: string) {
      const existing = rows.get(email);
      if (existing) return existing;
      const row: UserRecord = {
        id: crypto.randomUUID(),
        email,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        expoPushToken: null,
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
    async updatePushTokenByEmail(email: string, token: string) {
      const row = rows.get(email);
      if (!row || row.seeded) return null;
      row.expoPushToken = token;
      return row;
    },
  } satisfies UsersRepository;
  return { repository, rows };
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

describe('createApp', () => {
  let app: ReturnType<typeof createApp>;
  let rows: Map<string, UserRecord>;
  let cards: ReturnType<typeof fakeCards>;

  beforeEach(() => {
    const memory = createMemoryUsersRepository();
    rows = memory.rows;
    cards = fakeCards([card(1), card(2), card(3)]);
    app = createApp({
      users: memory.repository,
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
        expoPushToken: null,
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
        expoPushToken: null,
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
        push_token: null,
        created_at: '2026-09-12T00:00:00.000Z',
      });
    });

    it('200 /me after the upsert, with the design.md field names', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));
      rows.get(EMAIL)!.expoPushToken = 'ExponentPushToken[abc]';

      const response = await app.handle(request('/me', bearer(token)));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_token: 'ExponentPushToken[abc]',
      });
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
        push_token: null,
      });
      expect(rows.get(EMAIL)?.timezone).toBe('Asia/Seoul');
      expect(rows.get(EMAIL)?.reminderTime).toBe('06:45:00');
    });

    it('stores an Expo push token and returns the updated Me shape', async () => {
      const token = await signToken({ email: EMAIL });
      await app.handle(request('/auth/session', bearer(token, 'POST')));

      const response = await app.handle(
        request('/me/push-token', jsonPut(token, { token: 'ExpoPushToken[device-token]' })),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        timezone: 'UTC',
        reminder_time: '21:00:00',
        push_token: 'ExpoPushToken[device-token]',
      });
      expect(rows.get(EMAIL)?.expoPushToken).toBe('ExpoPushToken[device-token]');
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

    it('rejects a malformed push token without changing the row', async () => {
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
      expect(rows.get(EMAIL)?.expoPushToken).toBeNull();
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
        expect(rows.get(EMAIL)?.expoPushToken).toBe(pushToken);
      }
    });

    it('does not expose or change a seed-owned row through either write route', async () => {
      const seededEmail = 'load-0@example.test';
      const seeded = {
        id: crypto.randomUUID(),
        email: seededEmail,
        timezone: 'UTC',
        reminderTime: '21:00:00',
        expoPushToken: null,
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
      expoPushToken: null,
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
