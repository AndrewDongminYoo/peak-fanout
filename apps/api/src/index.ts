import { createReadWriteDb } from '@peak-fanout/db';
import { createRemoteJWKSet } from 'jose';

import { createApp } from './app';
import { createCardsCache, describeCardsCache, readCardsCacheConfig } from './cards/cache';
import { createDrizzleCardsRepository } from './cards/cards-drizzle';
import { createCardsService } from './cards/service';
import { createDrizzleDeliveriesRepository } from './deliveries-drizzle';
import { createDrizzleUsersRepository } from './users-drizzle';

export { createApp, type App, type AppDeps } from './app';
export type { DeliveriesRepository, DeliveryRecord } from './deliveries';
export type { UserRecord, UsersRepository } from './users';

/**
 * Parse the `PORT` environment value. Empty or unset falls back to 3000.
 * The whole value must be a decimal integer in 0-65535: `Number.parseInt`
 * would silently accept "3000abc" or "3000.5" as 3000.
 */
export function parsePort(raw: string | undefined): number {
  const value = raw || '3000';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535) {
    throw new Error(`PORT must be an integer in 0-65535, got "${raw}"`);
  }
  return port;
}

/** Read a required environment variable; an empty value counts as missing. */
export function requireEnv(name: string, env: Record<string, string | undefined>): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required; see .env.example`);
  }
  return value;
}

/** Supabase Auth publishes its signing keys here; jose fetches and caches them. */
export function supabaseJwksUrl(supabaseUrl: string): URL {
  return new URL('/auth/v1/.well-known/jwks.json', supabaseUrl);
}

// Wire the real dependencies and listen only when this file is the entry
// point, so tests and Eden can import the app without a port or a database.
if (import.meta.main) {
  const port = parsePort(process.env.PORT);
  const cacheConfig = readCardsCacheConfig(process.env);
  // `users` stays on the primary, because a login must see its own upsert; cards and deliveries
  // go to `db.read`, which is the primary's own pool when DATABASE_READ_URL is unset (design.md
  // "Data model"). An empty value counts as unset, as `requireEnv` reads one.
  const db = createReadWriteDb({
    writeUrl: requireEnv('DATABASE_URL', process.env),
    readUrl: process.env.DATABASE_READ_URL || undefined,
  });
  const app = createApp({
    users: createDrizzleUsersRepository(db.write),
    jwt: {
      secret: requireEnv('SUPABASE_JWT_SECRET', process.env),
      jwks: createRemoteJWKSet(supabaseJwksUrl(requireEnv('SUPABASE_URL', process.env))),
    },
    cards: createCardsService({
      repository: createDrizzleCardsRepository(db.read),
      cache: createCardsCache(cacheConfig),
    }),
    deliveries: createDrizzleDeliveriesRepository(db.read),
  });
  app.listen(port);
  console.log(
    `api listening on http://localhost:${port}, ${describeCardsCache(cacheConfig)}, ` +
      `reads ${db.read === db.write ? 'share the primary' : 'go to DATABASE_READ_URL'}`,
  );
}
