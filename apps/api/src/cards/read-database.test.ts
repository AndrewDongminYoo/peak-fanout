import { describe, expect, it } from 'bun:test';

import type { SqlClient } from '@peak-fanout/db';

import { readDatabaseEndpoint, verifyReadReplica } from './read-database';

// cspell:words sslmode

function sqlReturning(rows: unknown[]): SqlClient {
  return (() => Promise.resolve(rows)) as unknown as SqlClient;
}

describe('readDatabaseEndpoint', () => {
  it('identifies the endpoint without carrying credentials or query parameters', () => {
    expect(readDatabaseEndpoint('postgres://peak:secret@localhost:5433/peak?sslmode=disable')).toBe(
      'localhost:5433/peak',
    );
  });
});

describe('verifyReadReplica', () => {
  it('accepts only a database that reports itself in recovery', async () => {
    await expect(verifyReadReplica(sqlReturning([{ in_recovery: true }]))).resolves.toBeUndefined();
    await expect(verifyReadReplica(sqlReturning([{ in_recovery: false }]))).rejects.toThrow(
      'read database is not a standby',
    );
    await expect(verifyReadReplica(sqlReturning([]))).rejects.toThrow(
      'read-database identity query returned no row',
    );
  });
});
