import { beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';

import { createApp } from './app';
import type { CardsService, DayCards, ExpressionCard } from './cards/service';
import type { UserRecord, UsersRepository } from './users';

const SECRET = 'test-jwt-secret-with-at-least-32-characters-long';
const EMAIL = 'nightowl@example.com';
const KID = 'test-signing-key';

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
function signAsymmetricToken(claims: Record<string, unknown>, kid = KID, key?: CryptoKey) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key ?? signingKey);
}

/** In-memory `users`: enough to exercise the routes without Postgres. */
function createMemoryUsersRepository() {
  const rows = new Map<string, UserRecord>();
  const repository: UsersRepository = {
    async findByEmail(email) {
      return rows.get(email) ?? null;
    },
    async upsertByEmail(email) {
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
  };
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

/** Sign a token the way a legacy Supabase project does: HS256 with the project secret. */
function signToken(
  claims: Record<string, unknown>,
  { secret = SECRET, expiresIn = '1h' }: { secret?: string; expiresIn?: string | number } = {},
) {
  return new SignJWT(claims)
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
      jwt: { secret: SECRET, jwks },
      cards: cards.service,
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
      const token = await new SignJWT({ email: EMAIL })
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
        jwt: { secret: SECRET },
        cards: fakeCards([]).service,
      });
      const token = await signAsymmetricToken({ email: EMAIL });
      const response = await secretOnly.handle(request('/me', bearer(token)));

      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'invalid_token' });
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
      jwt: { secret: SECRET, jwks },
      cards: fakeCards([card(1)]).service,
    });
    const response = await app.handle(request('/cards/today'));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized', reason: 'missing_token' });
  });

  it('404 not_found before the first session upsert, as /me', async () => {
    const cards = fakeCards([card(1)]);
    app = createApp({
      users: createMemoryUsersRepository().repository,
      jwt: { secret: SECRET, jwks },
      cards: cards.service,
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
      jwt: { secret: SECRET, jwks },
      cards: cards.service,
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
      jwt: { secret: SECRET, jwks },
      cards: cards.service,
    });
    const token = await signedInUser();

    const response = await app.handle(request('/cards/today', bearer(token)));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ date: '2026-09-15', cards: [] });
  });
});
