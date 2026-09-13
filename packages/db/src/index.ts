import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export * from './schema';
export { isLoopbackHost, requireLoopbackDatabaseUrl } from './seed-guard';
export { PEAK_USER_COUNT, peakInstant, SEED_USER_COUNT, TARGET_DATE } from './seed-plan';
export { formatVerifyRows, verifyPeak, type VerifyRow } from './verify-peak';

export function createDb(url: string) {
  const client = postgres(url);
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * The raw `postgres` client, for the queries Drizzle does not own: the seed's `generate_series`
 * inserts, `load/verify-peak.sql`, and the load harness's own pool statements and `pg_stat_*`
 * samples. Exported so that `apps/api` reaches those through its declared dependency on this
 * package rather than importing a driver it does not depend on.
 */
export function createSqlClient(url: string) {
  return postgres(url);
}

export type SqlClient = ReturnType<typeof createSqlClient>;
