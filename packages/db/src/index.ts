import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema';

export * from './schema';
export { isLoopbackHost, requireLoopbackDatabaseUrl } from './seed-guard';
export {
  EXPRESSION_COUNT,
  PEAK_USER_COUNT,
  peakInstant,
  SEED_USER_COUNT,
  TARGET_DATE,
} from './seed-plan';
export { dayNumber, localDate } from './time';
export { formatVerifyRows, verifyPeak, type VerifyRow } from './verify-peak';

export function createDb(url: string) {
  const client = postgres(url);
  return drizzle({ client, schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * The read/write seam (design.md "Data model"): `write` is the primary and `read` is where reads
 * that tolerate replica lag go — expression cards now, the delivery log with M3 part 2.
 * When no read URL is set, `read` IS `write`: the same client and the same pool, so a deployment
 * without a replica opens no connection it did not open before.
 */
export type ReadWriteDb = {
  write: Db;
  read: Db;
};

/**
 * A pair over `createDb`: one client for `writeUrl`, and a second for `readUrl` only when one is
 * given. `createDb(url)` stays for the scheduler, the seed and the harness, which route nothing.
 */
export function createReadWriteDb({
  writeUrl,
  readUrl,
}: {
  writeUrl: string;
  readUrl?: string;
}): ReadWriteDb {
  const write = createDb(writeUrl);
  const read = readUrl ? createDb(readUrl) : write;
  return { write, read };
}

/** Closes the pair's pools: one `end` per pool, so a shared pool is not ended twice. */
export async function endReadWriteDb(
  db: ReadWriteDb,
  options?: Parameters<Db['$client']['end']>[0],
): Promise<void> {
  await db.write.$client.end(options);
  if (db.read !== db.write) await db.read.$client.end(options);
}

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
