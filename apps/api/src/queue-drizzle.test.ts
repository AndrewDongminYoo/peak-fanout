import { afterAll, describe, expect, it } from 'bun:test';

import {
  createDb,
  deliveries,
  jobs,
  reminders,
  requireLoopbackDatabaseUrl,
  users,
} from '@peak-fanout/db';
import { sql, type SQL } from 'drizzle-orm';

import { createDrizzleQueueRepository } from './queue-drizzle';

// Opt in only against a migrated task-only Compose database. Every fixture is rolled back.
// ADMIN_QUEUE_TEST_DATABASE_URL=postgres://.../peak_issue61 bun test src/queue-drizzle.test.ts
const databaseUrl = process.env.ADMIN_QUEUE_TEST_DATABASE_URL;
const db = databaseUrl ? createDb(requireLoopbackDatabaseUrl(databaseUrl)) : undefined;
afterAll(async () => {
  await db?.$client.end({ timeout: 5 });
});

describe.skipIf(!db)('queue snapshot SQL', () => {
  it('returns zero counts for an empty queue', async () => {
    expect(await createDrizzleQueueRepository(db!, 30_000).snapshotSeeded()).toEqual({
      waiting: 0,
      running: 0,
      failed: 0,
    });
  });

  it('counts seeded job states with database time and the exact worker reclaim boundary', async () => {
    const rollback = new Error('rollback queue fixtures');
    try {
      await db!.transaction(async (tx) => {
        const [seeded, ordinary] = await tx
          .insert(users)
          .values([
            { email: `queue-seeded-${crypto.randomUUID()}@example.test`, seeded: true },
            { email: `load-${crypto.randomUUID()}@example.test`, seeded: false },
          ])
          .returning();
        let sequence = 0;
        async function job(
          userId: string,
          fields: {
            runAt?: SQL;
            lockedAt?: SQL;
            doneAt?: SQL;
            deadAt?: SQL;
            attempts?: number;
            kind?: string;
          } = {},
        ) {
          sequence += 1;
          const [reminder] = await tx
            .insert(reminders)
            .values({
              userId,
              scheduledAt: new Date(Date.UTC(2026, 8, sequence)),
              state: 'queued',
            })
            .returning();
          await tx.insert(jobs).values({
            kind: 'send_reminder',
            payload: { reminder_id: reminder!.id },
            runAt: sql`now()`,
            ...fields,
          });
          return reminder!.id;
        }

        // Waiting: unlocked, delayed retry, expired lock, expired lock on a future retry.
        await job(seeded!.id);
        const retry = await job(seeded!.id, { runAt: sql`now() + interval '1 hour'`, attempts: 1 });
        await job(seeded!.id, { lockedAt: sql`now() - interval '30001 milliseconds'` });
        await job(seeded!.id, {
          lockedAt: sql`now() - interval '30001 milliseconds'`,
          runAt: sql`now() + interval '1 hour'`,
        });
        // Running: current lease, equality, and one millisecond inside the lease.
        await job(seeded!.id, { lockedAt: sql`now()` });
        await job(seeded!.id, { lockedAt: sql`now() - interval '30000 milliseconds'` });
        await job(seeded!.id, { lockedAt: sql`now() - interval '29999 milliseconds'` });
        // Completed jobs keep their old locks; only dead_at contributes to failed.
        await job(seeded!.id, { doneAt: sql`now()`, lockedAt: sql`now()` });
        await job(seeded!.id, { doneAt: sql`now()`, deadAt: sql`now()`, lockedAt: sql`now()` });
        await tx.insert(deliveries).values([
          { reminderId: retry, status: 'failed', latencyMs: 1, error: 'first attempt' },
          { reminderId: retry, status: 'failed', latencyMs: 1, error: 'second attempt' },
        ]);
        // Ordinary jobs in every state, another kind, and orphan/invalid references are excluded.
        await job(ordinary!.id);
        await job(ordinary!.id, { lockedAt: sql`now()` });
        await job(ordinary!.id, { doneAt: sql`now()`, deadAt: sql`now()` });
        await job(seeded!.id, { kind: 'other' });
        await tx.insert(jobs).values([
          {
            kind: 'send_reminder',
            payload: { reminder_id: crypto.randomUUID() },
            runAt: sql`now()`,
          },
          { kind: 'other', payload: { reminder_id: 'not-a-uuid' }, runAt: sql`now()` },
        ]);

        expect(await createDrizzleQueueRepository(tx, 30_000).snapshotSeeded()).toEqual({
          waiting: 4,
          running: 3,
          failed: 1,
        });
        // The same database instant under the configured longer lease reclassifies stale locks.
        expect(await createDrizzleQueueRepository(tx, 60_000).snapshotSeeded()).toEqual({
          waiting: 2,
          running: 5,
          failed: 1,
        });
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  });
});
