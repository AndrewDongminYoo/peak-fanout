import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  createDb,
  deliveries,
  jobs,
  pushReceipts,
  pushTokens,
  reminders,
  requireLoopbackDatabaseUrl,
  users,
  type Db,
} from '@peak-fanout/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { createDrizzlePushTokensRepository } from '../push-tokens-drizzle';
import { createDrizzleJobsRepository } from '../worker/jobs-drizzle';
import type { ClaimedJob } from '../worker/loop';
import { createDrizzleReceiptsRepository } from './receipts-drizzle';
import { pollReceiptBatch, type ReceiptUpdate } from './receipts';
import type { DeliverySender } from './sender';
import type { PushRegistration } from './sink';

// Opt-in local SQL regression suite. The SDK is never constructed or invoked.
const url = process.env.RECEIPTS_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const sender: DeliverySender = {
  kind: 'worker',
  sink: { kind: 'expo', access_token_configured: false },
  cards: {
    read_database: 'primary',
    cache: { enabled: true, fresh_ms: 60_000, stale_ms: 600_000, max_entries: 64 },
  },
};
const error: ReceiptUpdate = {
  status: 'error',
  errorCode: 'DeviceNotRegistered',
  lastError: null,
  checkedAt: new Date(),
  nextCheckAt: new Date(),
};

suite('receipt SQL on explicit local PostgreSQL', () => {
  let db: Db;
  const userIds: string[] = [];
  const jobIds: string[] = [];
  beforeAll(async () => {
    if (!url) throw new Error('RECEIPTS_TEST_DATABASE_URL is required');
    requireLoopbackDatabaseUrl(url);
    db = createDb(url);
    // Global SKIP LOCKED claims must never touch pre-existing app rows. Use a dedicated,
    // migrated database; refuse before fixtures or any mutation if it is not empty.
    const [existing] = await db.execute(sql`select
      exists(select 1 from users) or exists(select 1 from reminders)
      or exists(select 1 from jobs) or exists(select 1 from deliveries)
      or exists(select 1 from push_receipts) as populated`);
    if (existing?.populated)
      throw new Error('Receipt SQL tests require an empty dedicated database');
  });
  afterAll(async () => {
    if (!db) return;
    if (jobIds.length) await db.delete(jobs).where(inArray(jobs.id, jobIds));
    if (userIds.length) await db.delete(users).where(inArray(users.id, userIds));
    await db.$client.end();
  });
  async function fixture() {
    const [owner] = await db
      .insert(users)
      .values({ email: `receipt-${crypto.randomUUID()}@test.invalid` })
      .returning();
    if (!owner) throw new Error('fixture user missing');
    userIds.push(owner.id);
    const token = `ExponentPushToken[${crypto.randomUUID()}]`;
    await createDrizzlePushTokensRepository(db).registerForUser(owner.id, token);
    const [reminder] = await db
      .insert(reminders)
      .values({ userId: owner.id, scheduledAt: new Date(), state: 'queued' })
      .returning();
    if (!reminder) throw new Error('fixture reminder missing');
    const [job] = await db
      .insert(jobs)
      .values({ kind: 'send_reminder', payload: { reminder_id: reminder.id }, runAt: new Date() })
      .returning();
    if (!job) throw new Error('fixture job missing');
    jobIds.push(job.id);
    const repository = createDrizzleJobsRepository(db, sender);
    const claimed = (await repository.claim(100, 'receipt-test', 30_000)).find(
      (row) => row.id === job.id,
    );
    if (!claimed) throw new Error('fixture claim missing');
    const registration = claimed.reminder?.pushRegistrations?.[0];
    if (!registration) throw new Error('registration snapshot missing');
    return { owner, token, reminder, job: claimed, registration, repository };
  }
  async function record(
    f: {
      repository: ReturnType<typeof createDrizzleJobsRepository>;
      job: ClaimedJob;
      registration: PushRegistration;
    },
    ticketId: string,
  ) {
    await f.repository.complete(f.job, [{ latencyMs: 7, ticketId, registration: f.registration }]);
    const [row] = await db.select().from(pushReceipts).where(eq(pushReceipts.ticketId, ticketId));
    if (!row) throw new Error('receipt missing');
    return row;
  }
  async function makeDue(id: string) {
    await db
      .update(pushReceipts)
      .set({ nextCheckAt: new Date(0) })
      .where(eq(pushReceipts.deliveryId, id));
  }

  it('retains each accepted ticket including mixed attempts and duplicate completions, without changing send facts', async () => {
    const f = await fixture();
    await f.repository.retryOrDeadLetter(
      f.job,
      [
        { status: 'sent', latencyMs: 13, ticketId: 'mixed', registration: f.registration },
        { status: 'failed', latencyMs: 9, error: 'rejected' },
      ],
      { maxAttempts: 3, backoffBaseMs: 1_000 },
    );
    await record(f, 'complete');
    await record(f, 'duplicate');
    const rows = await db.select().from(deliveries).where(eq(deliveries.reminderId, f.reminder.id));
    expect(rows.map((row) => row.latencyMs).sort()).toEqual([13, 7, 7, 9].sort());
    const receiptRows = await db
      .select()
      .from(pushReceipts)
      .where(
        inArray(
          pushReceipts.deliveryId,
          rows.map((row) => row.id),
        ),
      );
    expect(receiptRows.map((row) => row.ticketId).sort()).toEqual([
      'complete',
      'duplicate',
      'mixed',
    ]);
    for (const row of receiptRows) {
      expect(row.pushTokenId).toBe(f.registration.id);
      expect(row.nextCheckAt.getTime() - row.acceptedAt.getTime()).toBe(900_000);
    }
    const [job] = await db.select().from(jobs).where(eq(jobs.id, f.job.id));
    expect(job?.attempts).toBe(1);
    expect(job?.doneAt).not.toBeNull();
  });

  it('never writes a receipt for simulation, even if a test double supplies a ticket', async () => {
    const f = await fixture();
    const simulated = createDrizzleJobsRepository(db, {
      ...sender,
      sink: { kind: 'simulated', min_latency_ms: 50, max_latency_ms: 150, failure_rate: 0 },
    });
    await simulated.complete(f.job, [{ latencyMs: 88, ticketId: 'not-real' }]);
    const [row] = await db
      .select()
      .from(deliveries)
      .where(eq(deliveries.reminderId, f.reminder.id));
    expect(row?.latencyMs).toBe(88);
    expect(
      await db.select().from(pushReceipts).where(eq(pushReceipts.deliveryId, row!.id)),
    ).toHaveLength(0);
  });

  it('waits 15 minutes, atomically partitions claims, and ignores completion from an older lease', async () => {
    const f = await fixture();
    const receipt = await record(f, 'lease');
    const repo = createDrizzleReceiptsRepository(db);
    expect(
      (await repo.claim(1_000, 300_000)).some((row) => row.deliveryId === receipt.deliveryId),
    ).toBe(false);
    await makeDue(receipt.deliveryId);
    const claims = (await Promise.all([repo.claim(1_000, 300_000), repo.claim(1_000, 300_000)]))
      .flat()
      .filter((row) => row.deliveryId === receipt.deliveryId);
    expect(claims).toHaveLength(1);
    await makeDue(receipt.deliveryId);
    const newer = (await repo.claim(1_000, 300_000)).find(
      (row) => row.deliveryId === receipt.deliveryId,
    )!;
    await repo.finish(claims[0]!, error);
    expect(
      await db.select().from(pushTokens).where(eq(pushTokens.id, f.registration.id)),
    ).toHaveLength(1);
    await repo.finish(newer, { ...error, status: 'ok', errorCode: null });
    await repo.finish(newer, error);
    const [stored] = await db
      .select()
      .from(pushReceipts)
      .where(eq(pushReceipts.deliveryId, receipt.deliveryId));
    expect(stored?.status).toBe('ok');
    expect(
      await db.select().from(pushTokens).where(eq(pushTokens.id, f.registration.id)),
    ).toHaveLength(1);
  });

  it('never leases a near-expiry receipt beyond its 24-hour deadline', async () => {
    const f = await fixture();
    const receipt = await record(f, 'lease-deadline');
    await db
      .update(pushReceipts)
      .set({
        acceptedAt: sql`now() - interval '23 hours 59 minutes'`,
        nextCheckAt: new Date(0),
      })
      .where(eq(pushReceipts.deliveryId, receipt.deliveryId));
    await createDrizzleReceiptsRepository(db).claim(1_000, 300_000);
    const [stored] = await db
      .select()
      .from(pushReceipts)
      .where(eq(pushReceipts.deliveryId, receipt.deliveryId));
    expect(stored!.nextCheckAt.getTime()).toBe(stored!.acceptedAt.getTime() + 86_400_000);
  });

  it('prunes only the exact registration and preserves its other installation', async () => {
    const f = await fixture();
    const otherToken = `ExponentPushToken[${crypto.randomUUID()}]`;
    await createDrizzlePushTokensRepository(db).registerForUser(f.owner.id, otherToken);
    const receipt = await record(f, 'prune');
    await createDrizzleReceiptsRepository(db).finish({ ...receipt }, error);
    expect(await createDrizzlePushTokensRepository(db).listByUserId(f.owner.id)).toEqual([
      otherToken,
    ]);
    const [stored] = await db
      .select()
      .from(pushReceipts)
      .where(eq(pushReceipts.deliveryId, receipt.deliveryId));
    expect(stored?.pushTokenId).toBeNull();
    expect(stored?.errorCode).toBe('DeviceNotRegistered');
  });

  it('preserves moved and re-registered rows, including a one-microsecond refresh', async () => {
    for (const mode of ['move', 'refresh'] as const) {
      const f = await fixture();
      const receipt = await record(f, `stale-${mode}`);
      if (mode === 'move') {
        const other = await fixture();
        await createDrizzlePushTokensRepository(db).registerForUser(other.owner.id, f.token);
      } else {
        await db
          .update(pushTokens)
          .set({ createdAt: sql`${pushTokens.createdAt} + interval '1 microsecond'` })
          .where(eq(pushTokens.id, f.registration.id));
      }
      await createDrizzleReceiptsRepository(db).finish({ ...receipt }, error);
      expect(
        await db.select().from(pushTokens).where(eq(pushTokens.id, f.registration.id)),
      ).toHaveLength(1);
    }
  });

  it('advances repeated registration in the same transaction and survives deletion during send', async () => {
    const f = await fixture();
    await db.transaction(async (tx) => {
      const read = () =>
        tx
          .select({ value: sql<string>`${pushTokens.createdAt}::text` })
          .from(pushTokens)
          .where(eq(pushTokens.id, f.registration.id));
      const [before] = await read();
      // Exercise the real upsert, which accepts the same Drizzle transaction operations.
      await createDrizzlePushTokensRepository(tx as unknown as Db).registerForUser(
        f.owner.id,
        f.token,
      );
      const [first] = await read();
      await createDrizzlePushTokensRepository(tx as unknown as Db).registerForUser(
        f.owner.id,
        f.token,
      );
      const [second] = await read();
      expect(before?.value).not.toBe(first?.value);
      expect(first?.value).not.toBe(second?.value);
    });
    await createDrizzlePushTokensRepository(db).removeForUser(f.owner.id, f.token);
    const receipt = await record(f, 'deleted-during-send');
    expect(receipt.pushTokenId).toBeNull();
    await createDrizzlePushTokensRepository(db).registerForUser(f.owner.id, f.token);
    await createDrizzleReceiptsRepository(db).finish({ ...receipt }, error);
    expect(await createDrizzlePushTokensRepository(db).listByUserId(f.owner.id)).toEqual([f.token]);
  });

  it('finishes duplicate invalid receipts concurrently with token deletion without lock inversion', async () => {
    const f = await fixture();
    const a = await record(f, 'concurrent-a');
    const b = await record(f, 'concurrent-b');
    const repo = createDrizzleReceiptsRepository(db);
    await Promise.all([
      repo.finish({ ...a }, error),
      repo.finish({ ...b }, error),
      createDrizzlePushTokensRepository(db).removeForUser(f.owner.id, f.token),
    ]);
    const rows = await db
      .select()
      .from(pushReceipts)
      .where(inArray(pushReceipts.deliveryId, [a.deliveryId, b.deliveryId]));
    expect(rows.map((row) => row.status)).toEqual(['error', 'error']);
    expect(rows.every((row) => row.pushTokenId === null)).toBe(true);
  });

  it('serializes two invalid receipts behind a held token lock', async () => {
    const f = await fixture();
    const a = await record(f, 'locked-a');
    const b = await record(f, 'locked-b');
    const repo = createDrizzleReceiptsRepository(db);
    let release = () => {};
    let ready = () => {};
    const held = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = db.transaction(async (tx) => {
      await tx
        .select({ id: pushTokens.id })
        .from(pushTokens)
        .where(eq(pushTokens.id, f.registration.id))
        .for('update');
      ready();
      await resume;
    });
    await held;
    const finishes = Promise.all([repo.finish({ ...a }, error), repo.finish({ ...b }, error)]);
    void finishes.catch(() => {});
    try {
      const deadline = Date.now() + 3_000;
      let waiting = 0;
      while (waiting < 2 && Date.now() < deadline) {
        const [locks] = await db.execute(sql`select count(*)::int as waiting from pg_stat_activity
          where datname = current_database() and wait_event_type = 'Lock'
            and query like '%"push_tokens"%' and query like '%for update%'`);
        waiting = Number(locks?.waiting);
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // Synchronize on PostgreSQL lock evidence, not elapsed time: both completions are now
      // blocked on the token. A receipt-first implementation holds both receipt rows here and
      // deadlocks in SET NULL after this lock is released.
      expect(waiting).toBe(2);
    } finally {
      release();
      await Promise.all([blocker, finishes]);
    }
    const rows = await db
      .select()
      .from(pushReceipts)
      .where(inArray(pushReceipts.deliveryId, [a.deliveryId, b.deliveryId]));
    expect(rows.every((row) => row.status === 'error' && row.pushTokenId === null)).toBe(true);
  });

  it('refuses an occupied test database before changing its rows', async () => {
    const f = await fixture();
    const before = await db.select().from(jobs).where(eq(jobs.id, f.job.id));
    const process = Bun.spawn(['bun', 'test', import.meta.path], {
      env: { ...Bun.env, RECEIPTS_TEST_DATABASE_URL: url },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const [exitCode, output] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).not.toBe(0);
    expect(output).toContain('Receipt SQL tests require an empty dedicated database');
    expect(await db.select().from(jobs).where(eq(jobs.id, f.job.id))).toEqual(before);
  });

  it('keeps a malformed invalid-token receipt pending, then prunes on a valid retry', async () => {
    const f = await fixture();
    const receipt = await record(f, 'malformed-retry');
    await makeDue(receipt.deliveryId);
    const repository = createDrizzleReceiptsRepository(db);
    const poll = (value: unknown) =>
      pollReceiptBatch({
        repository,
        now: () => new Date(),
        client: {
          async getPushNotificationReceiptsAsync() {
            return { 'malformed-retry': value };
          },
        },
      });
    await poll({ status: 'error', details: { error: 'DeviceNotRegistered' } });
    const [pending] = await db
      .select()
      .from(pushReceipts)
      .where(eq(pushReceipts.deliveryId, receipt.deliveryId));
    expect(pending).toMatchObject({
      status: 'pending',
      attempts: 1,
      errorCode: null,
      lastError: 'ReceiptMalformed',
    });
    expect(
      await db.select().from(pushTokens).where(eq(pushTokens.id, f.registration.id)),
    ).toHaveLength(1);
    await makeDue(receipt.deliveryId);
    await poll({
      status: 'error',
      message: 'Device is no longer registered',
      details: { error: 'DeviceNotRegistered' },
    });
    const [finished] = await db
      .select()
      .from(pushReceipts)
      .where(eq(pushReceipts.deliveryId, receipt.deliveryId));
    expect(finished).toMatchObject({
      status: 'error',
      attempts: 2,
      errorCode: 'DeviceNotRegistered',
      lastError: null,
      pushTokenId: null,
    });
    expect(
      await db.select().from(pushTokens).where(eq(pushTokens.id, f.registration.id)),
    ).toHaveLength(0);
  });

  it('allows a concurrent refresh to survive stale invalid receipt completion', async () => {
    const f = await fixture();
    const receipt = await record(f, 'concurrent-refresh');
    await Promise.all([
      createDrizzleReceiptsRepository(db).finish({ ...receipt }, error),
      createDrizzlePushTokensRepository(db).registerForUser(f.owner.id, f.token),
    ]);
    expect(await createDrizzlePushTokensRepository(db).listByUserId(f.owner.id)).toEqual([f.token]);
  });
});
