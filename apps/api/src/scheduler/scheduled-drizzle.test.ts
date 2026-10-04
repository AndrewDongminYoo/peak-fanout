import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import {
  createDb,
  jobs,
  pushTokens,
  reminders,
  requireLoopbackDatabaseUrl,
  users,
  type Db,
} from '@peak-fanout/db';
import { eq, inArray, sql } from 'drizzle-orm';

import { CARDS_CACHE_DEFAULTS } from '../cards/cache';
import { describeSender } from '../push/sender';
import { SIMULATED_SINK_DEFAULTS } from '../push/simulated';
import { createDrizzleJobsRepository } from '../worker/jobs-drizzle';
import { runWorkerLoop, WORKER_DEFAULTS } from '../worker/loop';
import { enqueueTick } from './enqueue';
import { createDrizzleRemindersRepository } from './reminders-drizzle';
import { TIMEZONE_LINKS } from './timezone-links';

// Explicitly opt in against an isolated, migrated loopback database. No provider is called.
const databaseUrl = process.env.SCHEDULED_REMINDERS_TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('ordinary scheduled reminders in PostgreSQL', () => {
  let db: Db;
  const ownedUsers: string[] = [];
  const now = new Date('2026-10-04T12:00:00Z');
  const sender = describeSender('worker', SIMULATED_SINK_DEFAULTS, {
    cache: CARDS_CACHE_DEFAULTS,
    readDatabase: 'primary',
  });

  beforeAll(async () => {
    db = createDb(requireLoopbackDatabaseUrl(databaseUrl));
    const [existing] = await db.execute(sql`SELECT
      EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM jobs) OR EXISTS(SELECT 1 FROM reminders) AS occupied`);
    if (existing?.occupied)
      throw new Error(
        'Scheduled reminder SQL tests require an empty dedicated database; existing application rows found',
      );
  });

  afterEach(async () => {
    if (ownedUsers.length === 0) return;
    await db.execute(sql`
      DELETE FROM jobs WHERE payload->>'reminder_id' IN (
        SELECT id::text FROM reminders WHERE user_id = ANY(${sql.param(ownedUsers)}::uuid[])
      )
    `);
    await db.delete(users).where(inArray(users.id, ownedUsers));
    ownedUsers.length = 0;
  });

  afterAll(async () => {
    await db?.$client.end();
  });

  async function user(overrides: Partial<typeof users.$inferInsert> = {}) {
    const [created] = await db
      .insert(users)
      .values({
        email: `scheduled-${crypto.randomUUID()}@example.test`,
        timezone: 'Asia/Seoul',
        reminderTime: '21:00',
        ...overrides,
      })
      .returning();
    if (!created) throw new Error('user insert returned nothing');
    ownedUsers.push(created.id);
    return created;
  }

  const forUser = (id: string) => db.select().from(reminders).where(eq(reminders.userId, id));

  it('resolves every Intl canonical zone and pinned link target to a PostgreSQL zone', async () => {
    const rows = await db.execute(sql`SELECT name FROM pg_timezone_names`);
    const known = new Set(rows.map((row) => String(row.name).toLowerCase()));
    const zones = [...Intl.supportedValuesOf('timeZone'), ...Object.values(TIMEZONE_LINKS)];
    expect(
      zones.filter(
        (zone) => !known.has((TIMEZONE_LINKS[zone.toLowerCase()] ?? zone).toLowerCase()),
      ),
    ).toEqual([]);
  });

  it('creates one current local day under concurrent ticks, freezes settings, and advances the next day', async () => {
    const ordinary = await user();
    const repository = createDrizzleRemindersRepository(db);

    await Promise.all([repository.materializeOrdinary(now), repository.materializeOrdinary(now)]);
    const first = await forUser(ordinary.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      localDate: '2026-10-04',
      scheduledTimezone: 'Asia/Seoul',
      scheduledAt: now,
      state: 'pending',
    });

    await db
      .update(users)
      .set({ timezone: 'UTC', reminderTime: '23:00' })
      .where(eq(users.id, ordinary.id));
    await repository.materializeOrdinary(now);
    expect(await forUser(ordinary.id)).toEqual(first);
    await repository.materializeOrdinary(new Date('2026-10-05T12:00:00Z'));
    const days = (await forUser(ordinary.id)).sort((a, b) =>
      a.localDate!.localeCompare(b.localDate!),
    );
    expect(days.map((row) => row.localDate)).toEqual(['2026-10-04', '2026-10-05']);
    expect(days[1]).toMatchObject({
      scheduledTimezone: 'UTC',
      scheduledAt: new Date('2026-10-05T23:00:00Z'),
    });
  });

  it('keeps distinct local dates that share an instant after a timezone change', async () => {
    const ordinary = await user({ timezone: 'Pacific/Kiritimati', reminderTime: '21:00' });
    const repository = createDrizzleRemindersRepository(db);
    const tick = new Date('2026-10-04T06:30:00Z');
    const scheduledAt = new Date('2026-10-04T07:00:00Z');

    await repository.materializeOrdinary(tick);
    const first = (await forUser(ordinary.id))[0];
    expect(first).toMatchObject({
      localDate: '2026-10-04',
      scheduledTimezone: 'Pacific/Kiritimati',
      scheduledAt,
    });

    // Both local clocks read 20:30, but the new timezone's current date is October 3.
    // This materializes that current day; it does not replay a missed historical day.
    await db.update(users).set({ timezone: 'Pacific/Honolulu' }).where(eq(users.id, ordinary.id));
    await Promise.all([repository.materializeOrdinary(tick), repository.materializeOrdinary(tick)]);

    const days = (await forUser(ordinary.id)).sort((a, b) =>
      a.localDate!.localeCompare(b.localDate!),
    );
    expect(days.map((row) => row.localDate)).toEqual(['2026-10-03', '2026-10-04']);
    expect(days[0]).toMatchObject({
      scheduledTimezone: 'Pacific/Honolulu',
      scheduledAt,
      state: 'pending',
    });
    expect(days[1]).toEqual(first);
  });

  it('keeps local dates across UTC midnight and applies PostgreSQL daylight-saving rules', async () => {
    const east = await user({ timezone: 'Pacific/Kiritimati' });
    const west = await user({ timezone: 'America/Los_Angeles' });
    const dst = await user({ timezone: 'America/New_York', reminderTime: '02:30' });
    const repository = createDrizzleRemindersRepository(db);

    await repository.materializeOrdinary(new Date('2026-03-08T10:00:00Z'));
    expect((await forUser(east.id))[0]).toMatchObject({
      localDate: '2026-03-09',
      scheduledAt: new Date('2026-03-09T07:00:00Z'),
    });
    expect((await forUser(west.id))[0]).toMatchObject({
      localDate: '2026-03-08',
      scheduledAt: new Date('2026-03-09T04:00:00Z'),
    });
    expect((await forUser(dst.id))[0]).toMatchObject({
      localDate: '2026-03-08',
      scheduledAt: new Date('2026-03-08T07:30:00Z'),
    });

    await db.update(users).set({ reminderTime: '01:30' }).where(eq(users.id, dst.id));
    await repository.materializeOrdinary(new Date('2026-11-01T12:00:00Z'));
    expect(
      (await forUser(dst.id)).find((row) => row.localDate === '2026-11-01')?.scheduledAt,
    ).toEqual(new Date('2026-11-01T06:30:00Z'));
  });

  it('honors existing Intl numeric offsets without PostgreSQL text-offset sign reversal', async () => {
    const east = await user({ timezone: '+01:00', reminderTime: '00:15' });
    const west = await user({ timezone: '-0230', reminderTime: '21:00' });
    const short = await user({ timezone: '+03', reminderTime: '21:00' });

    await createDrizzleRemindersRepository(db).materializeOrdinary(
      new Date('2026-10-04T23:30:00Z'),
    );

    expect((await forUser(east.id))[0]).toMatchObject({
      localDate: '2026-10-05',
      scheduledAt: new Date('2026-10-04T23:15:00Z'),
    });
    expect((await forUser(west.id))[0]).toMatchObject({
      localDate: '2026-10-04',
      scheduledAt: new Date('2026-10-04T23:30:00Z'),
    });
    expect((await forUser(short.id))[0]).toMatchObject({
      localDate: '2026-10-05',
      scheduledAt: new Date('2026-10-05T18:00:00Z'),
    });
  });

  it('resolves accepted IANA aliases missing from PostgreSQL while keeping the original snapshot', async () => {
    const aliases = [
      ['us/eastern', '2026-10-04', '2026-10-05T01:00:00Z'],
      ['Asia/Calcutta', '2026-10-05', '2026-10-05T15:30:00Z'],
      ['Europe/Kiev', '2026-10-05', '2026-10-05T18:00:00Z'],
      ['Asia/Choibalsan', '2026-10-05', '2026-10-05T13:00:00Z'],
    ] as const;
    const created = await Promise.all(aliases.map(([timezone]) => user({ timezone })));

    await createDrizzleRemindersRepository(db).materializeOrdinary(
      new Date('2026-10-04T23:30:00Z'),
    );

    for (let index = 0; index < aliases.length; index += 1) {
      const [timezone, localDate, scheduledAt] = aliases[index]!;
      expect((await forUser(created[index]!.id))[0]).toMatchObject({
        localDate,
        scheduledAt: new Date(scheduledAt),
        scheduledTimezone: timezone,
      });
    }
  });

  it('excludes seed and load-pool rows from materialization and creates no past-day backlog', async () => {
    const ordinary = await user({ createdAt: new Date('2020-01-01') });
    const seeded = await user({ seeded: true });
    const pool = await user({ loadPool: true });

    await createDrizzleRemindersRepository(db).materializeOrdinary(now);

    expect(await forUser(ordinary.id)).toHaveLength(1);
    expect(await forUser(seeded.id)).toEqual([]);
    expect(await forUser(pool.id)).toEqual([]);
  });

  it('enqueues ordinary reminders once when due and keeps naive and load ticks seeded-only', async () => {
    const ordinary = await user();
    const seeded = await user({ seeded: true });
    const pool = await user({ loadPool: true });
    await db.insert(reminders).values([
      { userId: seeded.id, scheduledAt: now },
      { userId: pool.id, scheduledAt: now },
    ]);
    const repository = createDrizzleRemindersRepository(db);

    expect((await enqueueTick({ reminders: repository, now, seededOnly: true })).enqueued).toBe(1);
    expect(await forUser(ordinary.id)).toEqual([]);
    expect((await forUser(pool.id))[0]?.state).toBe('pending');
    const before = new Date(now.getTime() - 60_000);
    expect((await enqueueTick({ reminders: repository, now: before })).enqueued).toBe(0);
    expect(await repository.dueReminders(now)).toEqual([]);
    const ticks = await Promise.all([
      enqueueTick({ reminders: repository, now }),
      enqueueTick({ reminders: repository, now }),
    ]);
    expect(ticks.reduce((count, tick) => count + tick.enqueued, 0)).toBe(1);
    expect((await forUser(ordinary.id))[0]?.state).toBe('queued');
  });

  it('uses the frozen timezone and completes no-device work once without delivery rows', async () => {
    const ordinary = await user();
    await enqueueTick({ reminders: createDrizzleRemindersRepository(db), now });
    await db
      .update(users)
      .set({ timezone: 'America/Los_Angeles' })
      .where(eq(users.id, ordinary.id));
    const worker = createDrizzleJobsRepository(db, sender);
    const [claimed] = await worker.claim(1, 'scheduled-test', 30_000);
    if (!claimed) throw new Error('expected ordinary job');
    expect(claimed.reminder).toMatchObject({
      timezone: 'Asia/Seoul',
      seeded: false,
      pushTokens: [],
    });

    const outcomes = await Promise.all([
      worker.skipNoTarget(claimed),
      worker.skipNoTarget(claimed),
    ]);
    expect(outcomes.sort()).toEqual(['recorded', 'reminder_not_queued']);
    expect((await forUser(ordinary.id))[0]?.state).toBe('skipped');
    const [stored] = await db.select().from(jobs).where(eq(jobs.id, claimed.id));
    expect(stored).toMatchObject({ attempts: 0, deadAt: null, lastError: null });
    expect(stored?.doneAt).toBeInstanceOf(Date);
    expect(
      await db.execute(
        sql`SELECT id FROM deliveries WHERE reminder_id = ${claimed.reminderId}::uuid`,
      ),
    ).toHaveLength(0);
    expect(await worker.claim(1, 'scheduled-test', 1)).toEqual([]);
  });

  it('leaves pre-existing ordinary retry jobs untouched when a measured worker claims', async () => {
    const ordinary = await user();
    const seeded = await user({ seeded: true });
    await db.insert(reminders).values({ userId: seeded.id, scheduledAt: now });
    await enqueueTick({ reminders: createDrizzleRemindersRepository(db), now });
    const [ordinaryReminder] = await forUser(ordinary.id);
    if (!ordinaryReminder) throw new Error('expected ordinary reminder');
    await db.execute(sql`UPDATE jobs SET attempts = 1, last_error = 'retry', locked_at = now() - interval '1 hour'
      WHERE payload->>'reminder_id' = ${ordinaryReminder.id}`);
    const before = await db.execute(
      sql`SELECT * FROM jobs WHERE payload->>'reminder_id' = ${ordinaryReminder.id}`,
    );

    const measured = createDrizzleJobsRepository(db, sender, { seededOnly: true });
    const claimed = await measured.claim(25, 'measured-test', 30_000);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.reminder?.seeded).toBe(true);
    expect(
      await db.execute(
        sql`SELECT * FROM jobs WHERE payload->>'reminder_id' = ${ordinaryReminder.id}`,
      ),
    ).toEqual(before);
  });

  it('sends once per registered installation using the stored PostgreSQL day and records sender provenance', async () => {
    // PostgreSQL and this Bun's ICU differ on Paraguay's 2026 summer offset. The stored
    // local day is authoritative regardless of the runtime's date for the same instant.
    const ordinary = await user({ timezone: 'America/Asuncion', reminderTime: '00:15' });
    const tokens = ['ExponentPushToken[scheduled-a]', 'ExponentPushToken[scheduled-b]'];
    await db.insert(pushTokens).values(tokens.map((token) => ({ userId: ordinary.id, token })));
    await enqueueTick({
      reminders: createDrizzleRemindersRepository(db),
      now: new Date('2026-07-16T03:15:00Z'),
    });
    const dates: string[] = [];
    const sent: Array<string | null> = [];
    const shutdown = new AbortController();

    const result = await runWorkerLoop({
      jobs: createDrizzleJobsRepository(db, sender),
      cards: {
        async forDate(date) {
          dates.push(date);
          return { date, cards: [] };
        },
        async todayFor() {
          throw new Error('ordinary cards must use the saved local date');
        },
      },
      sink: {
        async send(token) {
          sent.push(token);
          return { latencyMs: 7 };
        },
      },
      config: WORKER_DEFAULTS,
      workerId: 'ordinary-sql-test',
      clock: () => 0,
      sleep: async () => {
        shutdown.abort();
      },
      shutdown: shutdown.signal,
      log: () => {},
    });

    expect(result.sent).toBe(1);
    expect(dates).toEqual(['2026-07-16']);
    expect(sent.sort()).toEqual(tokens);
    const [reminder] = await forUser(ordinary.id);
    expect(reminder?.state).toBe('sent');
    const attempts = await db.execute(
      sql`SELECT latency_ms, sender FROM deliveries WHERE reminder_id = ${reminder!.id}::uuid`,
    );
    expect(attempts).toHaveLength(2);
    expect(attempts.every((attempt) => attempt.latency_ms === 7)).toBe(true);
    expect(attempts.map((attempt) => attempt.sender)).toEqual([sender, sender]);
  });
});
