// The identity a measured worker records for its cards read database.
//
// The endpoint deliberately omits credentials and query parameters. The worker verifies the
// connected server directly before calling itself a replica; the harness samples a connection to
// the same endpoint and grades the worker's record against it.

import type { SqlClient } from '@peak-fanout/db';

export function readDatabaseEndpoint(raw: string): string {
  const url = new URL(raw);
  const port = url.port || '5432';
  return `${url.hostname}:${port}${url.pathname}`;
}

export async function verifyReadReplica(sql: SqlClient): Promise<void> {
  const [row] = await sql<{ in_recovery: boolean }[]>`
    SELECT pg_is_in_recovery() AS in_recovery
  `;
  if (!row) throw new Error('the read-database identity query returned no row');
  if (!row.in_recovery) {
    throw new Error('the read database is not a standby (`pg_is_in_recovery()` returned false)');
  }
}
