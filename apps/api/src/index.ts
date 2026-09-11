import { createDb } from '@peak-fanout/db';
import { createRemoteJWKSet } from 'jose';

import { createApp } from './app';
import { createDrizzleUsersRepository } from './users-drizzle';

export { createApp, type App, type AppDeps } from './app';
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
  const app = createApp({
    users: createDrizzleUsersRepository(createDb(requireEnv('DATABASE_URL', process.env))),
    jwt: {
      secret: requireEnv('SUPABASE_JWT_SECRET', process.env),
      jwks: createRemoteJWKSet(supabaseJwksUrl(requireEnv('SUPABASE_URL', process.env))),
    },
  });
  app.listen(port);
  console.log(`api listening on http://localhost:${port}`);
}
