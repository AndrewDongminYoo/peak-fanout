import { describe, expect, it } from 'bun:test';

import { createSqlClient } from './index';
import { deleteSeededPopulation } from './seed';
import { requireLoopbackDatabaseUrl } from './seed-guard';

const databaseUrl = process.env.SCHEDULED_REMINDERS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('seed cleanup ownership in PostgreSQL', () => {
  it('removes all owned jobs while preserving ordinary reminders, jobs, and orphan history', async () => {
    const sql = createSqlClient(requireLoopbackDatabaseUrl(databaseUrl));
    const rollback = new Error('test rollback');
    const seeded = crypto.randomUUID();
    const ordinary = crypto.randomUUID();
    const seededReminder = crypto.randomUUID();
    const ordinaryReminder = crypto.randomUUID();
    const orphan = crypto.randomUUID();
    try {
      const [existing] = await sql`SELECT
        EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM jobs) OR EXISTS(SELECT 1 FROM reminders) AS occupied`;
      if (existing?.occupied)
        throw new Error(
          'Seed SQL tests require an empty dedicated database; existing application rows found',
        );
      await sql.begin(async (tx) => {
        await tx`INSERT INTO users (id, email, seeded) VALUES
          (${seeded}, ${`seed-cleanup-${seeded}@example.test`}, true),
          (${ordinary}, ${`ordinary-cleanup-${ordinary}@example.test`}, false)`;
        await tx`INSERT INTO reminders (id, user_id, scheduled_at, state) VALUES
          (${seededReminder}, ${seeded}, now(), 'queued'),
          (${ordinaryReminder}, ${ordinary}, now(), 'queued')`;
        // Open, completed, and dead-lettered fixture jobs must all disappear.
        await tx`INSERT INTO jobs (kind, payload, run_at, done_at, dead_at)
          SELECT 'send_reminder', jsonb_build_object('reminder_id', ${seededReminder}::text), now(), done_at, dead_at
          FROM (VALUES (NULL::timestamptz, NULL::timestamptz), (now(), NULL), (now(), now())) AS outcomes(done_at, dead_at)`;
        await tx`INSERT INTO jobs (kind, payload, run_at) VALUES
          ('send_reminder', jsonb_build_object('reminder_id', ${ordinaryReminder}::text), now()),
          ('send_reminder', jsonb_build_object('reminder_id', ${orphan}::text), now())`;

        await deleteSeededPopulation(tx);

        expect(await tx`SELECT id FROM users WHERE id = ${seeded}`).toHaveLength(0);
        expect(await tx`SELECT id FROM reminders WHERE id = ${ordinaryReminder}`).toHaveLength(1);
        expect(
          await tx`SELECT id FROM jobs WHERE payload->>'reminder_id' = ${seededReminder}`,
        ).toHaveLength(0);
        expect(
          await tx`SELECT id FROM jobs WHERE payload->>'reminder_id' = ${ordinaryReminder}`,
        ).toHaveLength(1);
        expect(
          await tx`SELECT id FROM jobs WHERE payload->>'reminder_id' = ${orphan}`,
        ).toHaveLength(1);
        throw rollback;
      });
    } catch (error) {
      if (error !== rollback) throw error;
    } finally {
      await sql.end();
    }
  });
});
