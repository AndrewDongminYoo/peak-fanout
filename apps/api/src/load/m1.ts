// The M1 measured run: `bun run load:m1`.
//
// One process drives the whole experiment and writes one `load/results/*.json`, which is the only
// thing a README measurement cell may be copied from (AGENTS.md gate rule 4).
// design.md "What one measured run assumes" and "Metric definitions and their sources" own the
// preconditions and the definitions; this file is their implementation and adds no metric of its
// own. It talks only to a stack on this machine, and it needs the scheduler running in another
// terminal — it says so, with the command, when nothing sends.
//
// A Bun script and not k6: the run has to read `pg_stat_database` and `pg_stat_activity` and to
// call `verifyPeak`, so it needs database access and this repository's own code, and one runtime
// keeps it inside the toolchain the rest of the repository already installs.

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  createSqlClient,
  formatVerifyRows,
  isLoopbackHost,
  PEAK_USER_COUNT,
  peakInstant,
  requireLoopbackDatabaseUrl,
  TARGET_DATE,
  verifyPeak,
  type SqlClient,
} from '@peak-fanout/db';
import { SignJWT } from 'jose';

import { requireEnv } from '../index';
import { summarizeRequests, withinWindow, type CounterSample, type RequestSample } from './metrics';
import { buildRunLog, runLogFileName, type RunLogInput } from './run-log';

/**
 * The API-load pool's addresses: a convention for a reader, and not what any query keys on.
 * Ownership is `users.load_pool`, which this harness sets when it inserts the row
 * (design.md "The load harness owns its API pool the same way").
 */
const POOL_EMAIL_PREFIX = 'apiload-';
const POOL_EMAIL_DOMAIN = '@example.test';

/** Requests already in flight past which the generator skips a beat instead of piling up. */
const MAX_REQUESTS_IN_FLIGHT = 50;

const RESULTS_DIR = join(import.meta.dir, '../../../../load/results');

type HarnessConfig = {
  databaseUrl: string;
  apiUrl: string;
  jwtSecret: string;
  poolUsers: number;
  requestsPerSecond: number;
  startTimeoutMs: number;
  stallTimeoutMs: number;
};

function readPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * The API URL has to be on this machine too. `new URL()` is the parser `fetch` itself uses here,
 * so its hostname is the host the requests go to and `isLoopbackHost` is the whole check —
 * the two-parser problem `requireLoopbackDatabaseUrl` solves cannot arise for an http URL.
 */
export function requireLoopbackApiUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`refusing to run: API_URL "${raw}" is not a URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`refusing to run: API_URL scheme "${url.protocol}" is not http or https.`);
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new Error(
      `refusing to run: API_URL host "${url.hostname}" is not a loopback address. The run creates ` +
        'and deletes users through this API, so it only talks to a stack on this machine.',
    );
  }
  return url.origin;
}

export function readHarnessConfig(env: Record<string, string | undefined>): HarnessConfig {
  return {
    // The seed's guard, given this command's own verb: it prefixes every refusal with the action,
    // so an operator who ran `bun run load:m1` is not told it is "refusing to seed".
    databaseUrl: requireLoopbackDatabaseUrl(env.DATABASE_URL, 'run'),
    apiUrl: requireLoopbackApiUrl(env.API_URL || 'http://localhost:3000'),
    // The harness signs its own pool's tokens, so it needs the value the API verifies with.
    // It never logs it, and no run log field carries it.
    jwtSecret: requireEnv('SUPABASE_JWT_SECRET', env),
    poolUsers: readPositiveInt(env, 'LOAD_POOL_USERS', 200),
    requestsPerSecond: readPositiveInt(env, 'LOAD_REQUESTS_PER_SECOND', 20),
    startTimeoutMs: readPositiveInt(env, 'LOAD_START_TIMEOUT_MS', 120_000),
    stallTimeoutMs: readPositiveInt(env, 'LOAD_STALL_TIMEOUT_MS', 120_000),
  };
}

/** One pool row as the insert returned it: the `id` is what the API's answer is checked against. */
type PoolRow = { id: string; email: string };

export type PoolUser = PoolRow & { token: string };

export function poolEmail(index: number): string {
  return `${POOL_EMAIL_PREFIX}${index}${POOL_EMAIL_DOMAIN}`;
}

async function mintToken(email: string, secret: string): Promise<string> {
  return new SignJWT({ email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('4h')
    .sign(new TextEncoder().encode(secret));
}

/** Postgres' unique-violation code, which for the pool insert means an address is taken. */
const UNIQUE_VIOLATION = '23505';

/**
 * Why the pool insert failed, as a refusal an operator can act on.
 *
 * A unique violation means one of the pool's addresses is held by a row this run did not write —
 * the sweep just before removed every row that does carry the flag — so the run refuses and
 * changes nothing. That is the same closure the seed relies on when a login took one of its
 * addresses first (design.md "The load harness owns its API pool the same way").
 */
export function describePoolInsertFailure(error: unknown): string {
  const { code, detail } = (error ?? {}) as { code?: unknown; detail?: unknown };
  if (code === UNIQUE_VIOLATION) {
    return (
      'refusing to run: an address the API-load pool needs is already held by a row this run did ' +
      `not create, so nothing was written (${String(detail ?? 'no detail from Postgres')}). That ` +
      'row does not carry `users.load_pool`, so the harness will not delete it; remove it by hand ' +
      'and run again.'
    );
  }
  return `could not create the API-load pool: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Create the API-load pool, recording ownership in the statement that creates the rows.
 *
 * It cannot reuse the seeded addresses: `POST /auth/session` answers 409 and `GET /me` answers
 * 404 for a row carrying `users.seeded` (design.md "Authentication"). So the harness writes its
 * own rows, marked `users.load_pool`.
 *
 * The harness writes them rather than letting `POST /auth/session` create them because the API
 * answers 200 whether it inserted the row or found one, which is indistinguishable — a flag set
 * after such a 200 would claim a row that was already there, and the delete at the end would take
 * it. One insert for the whole pool has no such gap: either every row is the harness's or the
 * unique index refuses the statement and nothing exists to clean up.
 *
 * The insert returns each row's `id`, and `verifyPoolThroughApi` then checks that the API answers
 * with those same ids: that is what proves it is on the database being measured.
 */
async function createPool(
  config: HarnessConfig,
  sql: SqlClient,
  lock: HeldLock,
): Promise<PoolUser[]> {
  // Whatever a killed run left behind. Keyed on the flag, so this deletes only harness rows, and
  // it cannot take a live run's pool because the run lock (`withRunLock`) admits one harness per
  // database at a time: a second run refuses before it reaches this line. The due-and-pending
  // count is not that guard — every peak reminder stays `pending` until the scheduler's first
  // delivery, so a second run started while the first waits for the scheduler passes it.
  const swept = await deletePool(sql, lock);
  if (swept > 0) {
    console.log(`swept ${swept} API-load users left behind by a run that did not finish`);
  }

  const emails = Array.from({ length: config.poolUsers }, (_, index) => poolEmail(index));
  let rows: PoolRow[];
  try {
    rows = await sql<PoolRow[]>`
      INSERT INTO users (email, load_pool) SELECT unnest(${emails}::text[]), true
      RETURNING id, email
    `;
  } catch (error) {
    throw new Error(describePoolInsertFailure(error), { cause: error });
  }

  const pool: PoolUser[] = [];
  for (const row of rows) {
    pool.push({ ...row, token: await mintToken(row.email, config.jwtSecret) });
  }
  await verifyPoolThroughApi(config.apiUrl, pool);
  console.log(
    `created ${pool.length} API-load users and verified through POST /auth/session that the API ` +
      'serves each one from this database',
  );
  return pool;
}

/** The API's answer for a pool user, reduced to the one fact the check reads. */
function readUserId(body: unknown): string | null {
  const { id } = (body ?? {}) as { id?: unknown };
  return typeof id === 'string' ? id : null;
}

/**
 * Prove through the API that it is up, that it verifies this harness's tokens, and that it is on
 * the database this run just wrote to.
 *
 * A 200 from `POST /auth/session` proves nothing about which database, because the route
 * upserts: an API on another database with the same signing secret creates the row THERE and
 * answers 200 just the same. The run would then measure `GET /me` against one database and the
 * counters, the connections and the fan-out against another, with every verdict check still met.
 * What does prove it is identity. `users.id` is generated by the database on insert, the pool
 * insert returned it, and the route returns the id of the row it served, so the two are equal
 * only when the API found this run's row — in this database.
 *
 * `GET /me` on the first pool user goes first because it writes nothing: a 404 means the API's
 * database holds no row at an address this run just inserted, and the run refuses before it has
 * asked that API to upsert anything. A 200 there means the upsert that follows finds a row that
 * already exists — this run's, or a stray one on another database, which the id comparison then
 * names — so no refusal raised here creates a row in any database.
 *
 * `fetchFn` is a parameter so the test drives this against a fake API and never a socket.
 */
export async function verifyPoolThroughApi(
  apiUrl: string,
  pool: PoolUser[],
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const first = pool[0];
  if (!first) throw new Error('the API-load pool is empty, so there is nothing to verify');

  const probe = await fetchFn(`${apiUrl}/me`, {
    headers: { authorization: `Bearer ${first.token}` },
  });
  await probe.text();
  if (probe.status === 404) {
    throw new Error(
      `refusing to run: GET /me answered 404 for ${first.email}, a row this run just inserted, ` +
        'so the API is running against a different DATABASE_URL than the one being measured. ' +
        'Nothing was written through it; point `bun run dev:api` at this database and run again.',
    );
  }
  if (probe.status !== 200) {
    throw new Error(
      `refusing to run: GET /me answered ${probe.status} for ${first.email}, a row this run just ` +
        'inserted. Is `bun run dev:api` running, with the same SUPABASE_JWT_SECRET this run was ' +
        'given?',
    );
  }

  for (const user of pool) {
    const response = await fetchFn(`${apiUrl}/auth/session`, {
      method: 'POST',
      headers: { authorization: `Bearer ${user.token}` },
    });
    if (response.status !== 200) {
      await response.text();
      throw new Error(
        `refusing to run: POST /auth/session answered ${response.status} for ${user.email}, a ` +
          'row this run just inserted. Is `bun run dev:api` running against this database, with ' +
          'the same SUPABASE_JWT_SECRET this run was given?',
      );
    }
    const servedId = readUserId(await response.json().catch(() => null));
    if (servedId === null) {
      throw new Error(
        `refusing to run: POST /auth/session answered 200 for ${user.email} without a user id, ` +
          "so whatever answered is not this repository's API.",
      );
    }
    if (servedId !== user.id) {
      throw new Error(
        `refusing to run: POST /auth/session served ${user.email} from a row this run did not ` +
          `create (the API returned id ${servedId}; this run's insert returned ${user.id}), so ` +
          'the API is running against a different DATABASE_URL than the one being measured. ' +
          "That row is not this run's to delete; point `bun run dev:api` at this database and " +
          'run again.',
      );
    }
  }
}

/**
 * Delete the pool by the fact recorded on its rows.
 *
 * No predicate over addresses: `users.load_pool` is true only for a row this harness inserted, so
 * this cannot reach a row the application created, whatever its address looks like. Pool users
 * have no `reminders` — the materializer writes only for seeded rows — so nothing cascades.
 */
async function deletePool(sql: SqlClient, lock: HeldLock): Promise<number> {
  // `load_pool` marks every harness's rows, not only this run's, so the sweep is safe exactly
  // while this run is the only harness — which is what the lock says, if it is still held.
  if (!(await lock.stillHeld())) {
    throw new Error(
      'refusing to sweep the API-load pool: the run lock is no longer held, so its connection ' +
        'dropped and another `bun run load:m1` may own these rows now. Nothing was deleted; ' +
        'the next run that does hold the lock sweeps them.',
    );
  }
  const deleted = await sql`DELETE FROM users WHERE load_pool`;
  return deleted.count;
}

export type PoolLifecycle = {
  create: () => Promise<PoolUser[]>;
  remove: () => Promise<number>;
  log?: (line: string) => void;
};

/**
 * Run `body` with the pool in place and delete the pool however this function ends.
 *
 * The delete has to cover every exit, because most of the ways a measured run ends are refusals
 * raised after the pool exists: a scheduler that never sent, a fan-out that recorded no delivery,
 * a window with no request in it. On the success path alone, every one of those left its rows in
 * the database being measured, and the next run then had rows at its own addresses that it had
 * not created — which is exactly the state an address-shaped delete cannot handle.
 *
 * `create` is covered too, and not only `body`: it writes the rows first and then verifies them
 * through the API, so a refusal from its second half leaves a whole pool behind.
 *
 * A cleanup failure is logged rather than thrown: the error it interrupted is the one worth
 * reporting, and the rows carry the flag, so the next run's sweep is the remedy either way.
 */
export async function withApiLoadPool<T>(
  { create, remove, log = console.log }: PoolLifecycle,
  body: (pool: PoolUser[]) => Promise<T>,
): Promise<T> {
  const cleanUp = async () => {
    try {
      log(`\ndeleted ${await remove()} API-load users`);
    } catch (error) {
      log(
        `could not delete the API-load users: ${error instanceof Error ? error.message : String(error)}. ` +
          'They carry `users.load_pool`, so the next run sweeps them before it starts.',
      );
    }
  };

  let pool: PoolUser[];
  try {
    pool = await create();
  } catch (error) {
    await cleanUp();
    throw error;
  }

  try {
    return await body(pool);
  } finally {
    await cleanUp();
  }
}

export type RunLockDeps = {
  /** One attempt at the lock: true when this run now holds it, false when another run does. */
  tryLock: () => Promise<boolean>;
  /**
   * Whether this run still holds the lock. A session lock ends with its connection, and the
   * server tells nobody: if the reserved connection dropped mid-run, another harness can hold the
   * lock now and own the rows a sweep would take. Checked before every sweep, never assumed.
   */
  stillHeld: () => Promise<boolean>;
  /** Give it back. Called once, after `body` has settled, however it settled. */
  unlock: () => Promise<void>;
  log?: (line: string) => void;
};

/** What `withRunLock` hands `body`: the one question a run may ask about its lock. */
export type HeldLock = { stillHeld: () => Promise<boolean> };

/**
 * Run `body` as the only measured run on this database, or refuse before touching anything.
 *
 * This exists because the due-and-pending assertion in `run` was once taken for a run lock, and
 * it is not one: design.md "What one measured run assumes" owns why, and what a second harness
 * did to the first one's pool while both passed that check.
 *
 * The unlock covers every exit, and it runs after `body` — so after the pool delete inside it.
 * A failed unlock is logged rather than thrown: the run's own error is the one worth reporting,
 * and the lock goes with this process's connection regardless.
 */
export async function withRunLock<T>(
  { tryLock, stillHeld, unlock, log = console.log }: RunLockDeps,
  body: (lock: HeldLock) => Promise<T>,
): Promise<T> {
  if (!(await tryLock())) {
    throw new Error(
      'refusing to run: another `bun run load:m1` holds this database. One measured run at a ' +
        "time — a second harness would sweep the first one's API-load pool and double its " +
        'request rate. Wait for it to finish. A run that was killed released the lock with its ' +
        'connection, so there is nothing to clear by hand.',
    );
  }
  try {
    return await body({ stillHeld });
  } finally {
    try {
      await unlock();
    } catch (error) {
      log(
        `could not release the run lock: ${error instanceof Error ? error.message : String(error)}. ` +
          "It goes with this process's connection, so ending the process releases it.",
      );
    }
  }
}

/**
 * The advisory lock key every harness on a database asks for. Any fixed value would do — what
 * matters is that all of them ask for the same one — and this is the ASCII of `PEAK`, so the row
 * in `pg_locks` is recognizable and the value is tied to no count or instant.
 */
const RUN_LOCK_KEY = 0x5045414b;

/**
 * The run lock as Postgres holds it: `pg_try_advisory_lock` on a connection reserved for it alone.
 *
 * A session-level advisory lock belongs to the backend that took it. Through the pool that would
 * be whichever connection was free, and an unlock sent later through another connection returns
 * false and leaves the lock held. `sql.reserve()` pins one connection; the lock and its unlock
 * both go through that handle, and nothing else does. `release()` alone would not unlock — the
 * connection goes back to the pool with its session, lock included — so the unlock comes first.
 *
 * A row in a table would outlive a killed process and need clearing by hand; the session lock
 * ends when the connection drops, which is why it is a lock and not a row.
 */
export function runLockOnDatabase(sql: SqlClient): RunLockDeps {
  let session: Awaited<ReturnType<SqlClient['reserve']>> | null = null;
  return {
    async tryLock() {
      session = await sql.reserve();
      const [row] = await session<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${RUN_LOCK_KEY}::bigint) AS locked
      `;
      if (row?.locked) return true;
      session.release();
      session = null;
      return false;
    },
    async stillHeld() {
      // A session-level advisory lock cannot be lost while its session lives, and it cannot
      // outlive it, so "is the reserved connection still answering" is the whole question.
      if (!session) return false;
      try {
        await session`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async unlock() {
      if (!session) return;
      try {
        await session`SELECT pg_advisory_unlock(${RUN_LOCK_KEY}::bigint)`;
      } finally {
        session.release();
        session = null;
      }
    },
  };
}

type Traffic = {
  samples: RequestSample[];
  skipped: () => number;
  stop: () => Promise<void>;
};

/**
 * `GET /me` at a fixed rate, round-robin over the pool, recording every response.
 *
 * The rate is fixed and low on purpose: the question is what the fan-out does to the API's
 * latency, not how many clients the API can hold (design.md "What the M1 measurements cover").
 */
function startTraffic(config: HarnessConfig, pool: PoolUser[]): Traffic {
  const samples: RequestSample[] = [];
  const url = `${config.apiUrl}/me`;
  const intervalMs = Math.max(1, Math.round(1000 / config.requestsPerSecond));
  let next = 0;
  let inFlight = 0;
  let skipped = 0;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    if (inFlight >= MAX_REQUESTS_IN_FLIGHT) {
      skipped += 1;
      return;
    }
    const user = pool[next % pool.length] as PoolUser;
    next += 1;
    inFlight += 1;
    const startedAt = Date.now();
    fetch(url, { headers: { authorization: `Bearer ${user.token}` } })
      .then(async (response) => {
        await response.text();
        samples.push({ startedAt, durationMs: Date.now() - startedAt, status: response.status });
      })
      .catch(() => {
        // No status at all: the request never completed. It counts as an error, not as a gap.
        samples.push({ startedAt, durationMs: Date.now() - startedAt, status: 0 });
      })
      .finally(() => {
        inFlight -= 1;
      });
  }, intervalMs);

  return {
    samples,
    skipped: () => skipped,
    async stop() {
      stopped = true;
      clearInterval(timer);
      while (inFlight > 0) await Bun.sleep(50);
    },
  };
}

type Progress = { pending: number; attempts: number; connections: number };

/**
 * One round trip for the three numbers the window loop needs.
 *
 * `pending` and `attempts` both count the seeded population only, keyed on `users.seeded` exactly
 * as `dueAtPeak`, `markPrePeakSent`, `readFanout` and the scheduler's own `dueReminders` are: the
 * scheduler never selects an application user's reminder (design.md "The scheduler"), so a
 * `pending` count that included one would never reach zero, `waitForFanoutEnd` would report a
 * finished fan-out as stalled, and the run log's "reached a terminal state" check — fed by this
 * same number as `pendingAfter` — would miss for a run that did what it set out to do. The
 * `attempts` count is scoped the same way so that it and `remindersAtPeak` are one population:
 * the run log grades them against each other with strict equality.
 */
async function pollProgress(sql: SqlClient, peak: Date): Promise<Progress> {
  const [row] = await sql<Progress[]>`
    SELECT
      (SELECT count(*) FROM reminders AS r
        WHERE r.scheduled_at = ${peak} AND r.state = 'pending'
          AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = r.user_id AND u.seeded))::int AS pending,
      (SELECT count(*) FROM deliveries AS d
        JOIN reminders AS r ON r.id = d.reminder_id
        WHERE r.scheduled_at = ${peak}
          AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = r.user_id AND u.seeded))::int AS attempts,
      (SELECT count(*) FROM pg_stat_activity
        WHERE datname = current_database())::int AS connections
  `;
  if (!row) throw new Error('the progress query returned no row');
  return row;
}

async function sampleCounters(sql: SqlClient): Promise<CounterSample> {
  const [row] = await sql<{ xact_commit: string; xact_rollback: string }[]>`
    SELECT xact_commit, xact_rollback
    FROM pg_stat_database WHERE datname = current_database()
  `;
  if (!row) throw new Error('pg_stat_database has no row for the application database');
  return {
    atMs: Date.now(),
    xactCommit: Number(row.xact_commit),
    xactRollback: Number(row.xact_rollback),
  };
}

async function readMaxConnections(sql: SqlClient): Promise<number> {
  const [row] = await sql<{ max_connections: string }[]>`
    SELECT current_setting('max_connections') AS max_connections
  `;
  return Number(row?.max_connections);
}

/**
 * The initial condition a scheduler that had been running all day would have left: every
 * reminder of the target date before the peak instant already `sent`.
 * design.md "What one measured run assumes" says why the run establishes it instead of sending
 * some 36,000 reminders that measure nothing new, and why no verification number moves.
 */
async function markPrePeakSent(sql: SqlClient, peak: Date): Promise<number> {
  const updated = await sql`
    UPDATE reminders AS r SET state = 'sent'
    WHERE r.state = 'pending'
      AND r.scheduled_at < ${peak}
      AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = r.user_id AND u.seeded)
  `;
  return updated.count;
}

/**
 * The one assertion that proves the measured window is the peak alone: everything due and pending
 * at the peak instant, and how much of it sits exactly on that instant.
 */
async function dueAtPeak(
  sql: SqlClient,
  peak: Date,
): Promise<{ due_pending: number; due_at_peak: number }> {
  const [row] = await sql<{ due_pending: number; due_at_peak: number }[]>`
    SELECT
      (count(*))::int AS due_pending,
      (count(*) FILTER (WHERE r.scheduled_at = ${peak}))::int AS due_at_peak
    FROM reminders AS r
    WHERE r.state = 'pending' AND r.scheduled_at <= ${peak}
      AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = r.user_id AND u.seeded)
  `;
  if (!row) throw new Error('the due-and-pending query returned no row');
  return row;
}

type FanoutRow = {
  attempts: number;
  sent: number;
  failed: number;
  first_send_started_at: Date | null;
  last_send_finished_at: Date | null;
  /** `deliveries.latency_ms`, which the sink measured and the scheduler wrote. */
  min_latency_ms: string | null;
  max_latency_ms: string | null;
  mean_latency_ms: string | null;
};

/**
 * The fan-out as the scheduler recorded it. The duration comes from these rows and is not
 * re-timed from outside: a send started `latency_ms` before its `deliveries.created_at`.
 *
 * The three latency figures come from the same statement because they are the same observation:
 * what the sender's sink actually cost per send. The harness cannot read that from its own
 * environment — the sends happen in another process (design.md "The push sink").
 *
 * Seeded rows only, on the same `users.seeded` fact every other count in this file keys on: an
 * application user's reminder is not part of a load experiment (design.md "The scheduler"), so
 * its delivery, were one ever to land on the peak instant, belongs in none of these figures.
 */
async function readFanout(sql: SqlClient, peak: Date, windowEndedAt: Date): Promise<FanoutRow> {
  // Bounded at the window's close: `deliveries.created_at` is the database's clock, so the bound
  // is the harness clock at close as the database would compare it, which errs by at most the
  // skew between the two on one machine. A delivery a resumed scheduler writes after the close is
  // outside what the API and database measurements covered and must not enter the record.
  const [row] = await sql<FanoutRow[]>`
    SELECT
      (count(*))::int AS attempts,
      (count(*) FILTER (WHERE d.status = 'sent'))::int AS sent,
      (count(*) FILTER (WHERE d.status = 'failed'))::int AS failed,
      min(d.created_at - (d.latency_ms * interval '1 millisecond')) AS first_send_started_at,
      max(d.created_at) AS last_send_finished_at,
      min(d.latency_ms) AS min_latency_ms,
      max(d.latency_ms) AS max_latency_ms,
      round(avg(d.latency_ms), 2) AS mean_latency_ms
    FROM deliveries AS d
    JOIN reminders AS r ON r.id = d.reminder_id
    WHERE r.scheduled_at = ${peak}
      AND d.created_at <= ${windowEndedAt}
      AND EXISTS (SELECT 1 FROM users AS u WHERE u.id = r.user_id AND u.seeded)
  `;
  if (!row) throw new Error('the fan-out query returned no row');
  return row;
}

/**
 * The scheduler command a measured run needs, as a line to paste into a fresh terminal.
 *
 * It sets `SCHEDULER_NOW` and nothing else. It used to carry `DATABASE_URL="$DATABASE_URL"` as
 * well, and that prefix killed the scheduler on the documented setup: in a fresh terminal the
 * variable is unset, so the prefix sets it to the empty string; Bun never overrides a variable
 * that is already set, even to empty, from `.env`; and `requireEnv` rejects the empty string. The
 * prefix had no upside either — a shell that does have the variable set passes it to the child
 * without being asked. So `DATABASE_URL` reaches the scheduler the way it reaches every script
 * here: from the shell when set there, otherwise from `.env`.
 */
export function schedulerCommand(peak: Date): string {
  return `SCHEDULER_NOW=${peak.toISOString()} bun run dev:scheduler`;
}

function startSchedulerHint(peak: Date): string {
  return (
    'Start the scheduler in another terminal, with the instant this seed is for. Leave every\n' +
    'PUSH_SIM_* variable at its default there: the run log grades the send cost it measures\n' +
    'against the pinned distribution, so other values make this run a different experiment.\n' +
    'DATABASE_URL reaches it as it reaches every script here: from the shell when set there,\n' +
    'otherwise from .env.\n\n' +
    `  ${schedulerCommand(peak)}\n`
  );
}

async function waitForFanoutStart(
  sql: SqlClient,
  peak: Date,
  timeoutMs: number,
): Promise<Progress> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const progress = await pollProgress(sql, peak);
    if (progress.attempts > 0) return progress;
    if (Date.now() > deadline) {
      throw new Error(
        `nothing was delivered for the peak instant within ${Math.round(timeoutMs / 1000)}s. ` +
          startSchedulerHint(peak),
      );
    }
    await Bun.sleep(500);
  }
}

export type FanoutEnd = {
  peakConnections: number;
  attempts: number;
  pending: number;
  /** True when the harness gave up on a fan-out that had stopped making progress. */
  stalled: boolean;
};

export type FanoutEndDeps = {
  /** One progress reading. `run` passes `pollProgress`; the test passes a list of readings. */
  poll: () => Promise<Progress>;
  stallTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
};

/**
 * Poll until the last reminder on the peak instant leaves `pending`, or until the fan-out has
 * made no progress for `stallTimeoutMs`.
 *
 * A stall RETURNS rather than throwing, and that is the whole reason this function has injected
 * dependencies. A throw here would end the run before `buildRunLog`, so the one outcome the
 * verdict exists to catch — reminders that never reached a terminal state — could never appear in
 * a run log, and `verdict.met` would be structurally incapable of reading false on two of its
 * three checks. Returning instead means a stalled run still writes its log, states what it missed
 * and exits non-zero, which is what makes the log a gate (design.md "Metric definitions and their
 * sources"). Nothing downstream needs the poll loop's own clock, so `now` and `sleep` are here
 * only to keep the stall test off the real one.
 */
export async function waitForFanoutEnd({
  poll,
  stallTimeoutMs,
  sleep = Bun.sleep,
  now = Date.now,
  log = console.log,
}: FanoutEndDeps): Promise<FanoutEnd> {
  let peakConnections = 0;
  let lastAttempts = -1;
  let lastChangeAt = now();
  let lastLogAt = 0;

  for (;;) {
    const progress = await poll();
    peakConnections = Math.max(peakConnections, progress.connections);
    if (progress.attempts !== lastAttempts) {
      lastAttempts = progress.attempts;
      lastChangeAt = now();
    }
    if (now() - lastLogAt >= 10_000) {
      lastLogAt = now();
      log(
        `  fan-out ${progress.attempts} attempted, ${progress.pending} still pending, ${progress.connections} connections`,
      );
    }
    const drained = progress.pending === 0;
    if (drained || now() - lastChangeAt > stallTimeoutMs) {
      return {
        peakConnections,
        attempts: progress.attempts,
        pending: progress.pending,
        stalled: !drained,
      };
    }
    await sleep(1000);
  }
}

type WindowMeasurement = {
  windowStartedAt: Date;
  windowEndedAt: Date;
  before: CounterSample;
  after: CounterSample;
  peakConnections: number;
  /**
   * The fan-out as it stood when the window closed, read by the same poll that closed it.
   * `run` grades the run on these and not on a later read, because the window has to end before
   * traffic can be stopped and the counters sampled, and a scheduler that stalled long enough to
   * close the window can resume during that gap; a later read would then describe sends the API
   * and database measurements never saw.
   */
  atClose: { pending: number; attempts: number; stalled: boolean };
};

/**
 * The window itself: wait for the scheduler's first delivery, sample the counters, poll until the
 * last reminder on the peak instant leaves `pending`, sample again. The traffic is stopped here
 * however this ends, so a refusal in the middle does not leave a generator running.
 *
 * A fan-out that stalls is measured to where it got and then reported as a missed run, not
 * thrown away: the log is the artifact that says what the run failed to do.
 */
async function measureWindow(
  sql: SqlClient,
  peak: Date,
  config: HarnessConfig,
  traffic: Traffic,
): Promise<WindowMeasurement> {
  try {
    await waitForFanoutStart(sql, peak, config.startTimeoutMs);
    const windowStartedAt = new Date();
    const before = await sampleCounters(sql);
    console.log(`fan-out observed at ${windowStartedAt.toISOString()}`);

    const end = await waitForFanoutEnd({
      poll: () => pollProgress(sql, peak),
      stallTimeoutMs: config.stallTimeoutMs,
    });
    const windowEndedAt = new Date();
    const after = await sampleCounters(sql);
    if (end.stalled) {
      console.error(
        `\nthe fan-out stopped making progress for ${Math.round(config.stallTimeoutMs / 1000)}s ` +
          `at ${end.attempts} attempts with ${end.pending} still pending. This run misses its ` +
          'verdict; the log below records how far it got.\n\n' +
          startSchedulerHint(peak),
      );
    }
    return {
      windowStartedAt,
      windowEndedAt,
      before,
      after,
      peakConnections: end.peakConnections,
      atClose: { pending: end.pending, attempts: end.attempts, stalled: end.stalled },
    };
  } finally {
    await traffic.stop();
  }
}

export type GitProvenance = { baseCommit: string; worktreeDirty: boolean };

/**
 * One git command's trimmed stdout. A function so the reader below can be tested without one.
 *
 * A non-zero exit throws rather than returning the empty stdout a failed command leaves behind:
 * `git status --porcelain` failing with nothing on stdout is indistinguishable from a clean tree
 * by output alone, and a run log that read `worktree_dirty: false` off that would be provenance
 * for a tree git could not even read.
 */
export async function runGit(args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} exited ${code}: ${err.trim() || '(no stderr)'}`);
  }
  return out.trim();
}

/**
 * Where the run was performed, stated as narrowly as it can honestly be stated.
 *
 * `HEAD` is the commit the run sits ON TOP OF and not the commit that produced it: a measured run
 * has to happen before the commit that carries its log, so the code under measurement is the
 * working tree, and at that moment no commit contains it. `worktreeDirty` is the field that says
 * so — for a run committed in its own pull request it is true — and the pull request body carries
 * the run's stdout, which is the only artifact that ties the numbers to the diff.
 *
 * `run` reads this once, at its entry beside `startedAt`, and `measure` takes the result as an
 * argument rather than reading it again. The window is a quarter of an hour long, and a commit or
 * a hook's restage made during it would otherwise have the log name a `HEAD` that did not exist
 * when the measured code was loaded, or turn `worktreeDirty` false for a tree that was dirty when
 * the run began. Both fields describe the instant the run started, which is the instant
 * `started_at` records.
 */
export async function gitProvenance(
  git: (args: string[]) => Promise<string> = runGit,
): Promise<GitProvenance> {
  const baseCommit = await git(['rev-parse', 'HEAD']);
  if (!baseCommit) throw new Error('could not read the current git commit');
  const status = await git(['status', '--porcelain']);
  return { baseCommit, worktreeDirty: status !== '' };
}

type MeasureArgs = {
  config: HarnessConfig;
  sql: SqlClient;
  peak: Date;
  startedAt: Date;
  /** Read by `run` at the same instant as `startedAt`; see `gitProvenance` for why not later. */
  provenance: GitProvenance;
  seed: RunLogInput['seed'];
  /** Reminders sitting on the peak instant, which is what the run set out to send. */
  remindersAtPeak: number;
  maxConnections: number;
  pool: PoolUser[];
};

/**
 * The measured window and the run log it produces, with the pool already in place.
 *
 * This is a separate function from `run` so that everything which happens once the pool exists
 * sits inside the one `finally` that deletes it (`withApiLoadPool`), rather than on the success
 * path alone: every refusal below would otherwise leave the pool in the measured database.
 */
async function measure({
  config,
  sql,
  peak,
  startedAt,
  provenance,
  seed,
  remindersAtPeak,
  maxConnections,
  pool,
}: MeasureArgs): Promise<boolean> {
  const traffic = startTraffic(config, pool);
  console.log(`GET /me at ${config.requestsPerSecond}/s; waiting for the scheduler to send.`);
  // Printed while there is still time to act on it: the scheduler is a separate process, and this
  // line is where the instant to give it comes from, so no document has to restate it.
  console.log(startSchedulerHint(peak));

  const { windowStartedAt, windowEndedAt, before, after, peakConnections, atClose } =
    await measureWindow(sql, peak, config, traffic);

  const fanout = await readFanout(sql, peak, windowEndedAt);
  if (!fanout.first_send_started_at || !fanout.last_send_finished_at) {
    throw new Error('the fan-out recorded no delivery for the peak instant');
  }

  // The API side, sliced to the window the harness observed. The request timestamps are this
  // process's clock and the `deliveries` timestamps are the database's, so the slice uses the
  // observed window rather than mixing the two clocks.
  const inWindow = withinWindow(
    traffic.samples,
    windowStartedAt.getTime(),
    windowEndedAt.getTime(),
  );
  if (inWindow.length === 0) {
    throw new Error('no API request fell inside the fan-out window, so p95 would measure nothing');
  }

  const log = buildRunLog({
    baseCommit: provenance.baseCommit,
    worktreeDirty: provenance.worktreeDirty,
    startedAt,
    endedAt: new Date(),
    seed,
    // Measured, not declared: these come from the rows the sender wrote. `buildRunLog` supplies
    // the pinned parameters from the sink module itself and takes none from here.
    sink: {
      observedMinLatencyMs: Number(fanout.min_latency_ms),
      observedMaxLatencyMs: Number(fanout.max_latency_ms),
      observedMeanLatencyMs: Number(fanout.mean_latency_ms),
    },
    fanout: {
      reminders: remindersAtPeak,
      attempts: fanout.attempts,
      sent: fanout.sent,
      failed: fanout.failed,
      pendingAfter: atClose.pending,
      firstSendStartedAt: fanout.first_send_started_at,
      lastSendFinishedAt: fanout.last_send_finished_at,
    },
    api: {
      url: config.apiUrl,
      poolUsers: pool.length,
      requestsPerSecond: config.requestsPerSecond,
      requestsTotal: traffic.samples.length,
      requestsSkipped: traffic.skipped(),
      windowStartedAt,
      windowEndedAt,
      window: summarizeRequests(inWindow),
    },
    database: { before, after, peakConnections, maxConnections },
  });

  await mkdir(RESULTS_DIR, { recursive: true });
  const path = join(RESULTS_DIR, runLogFileName(startedAt));
  await Bun.write(path, `${JSON.stringify(log, null, 2)}\n`);

  console.log(`\n${JSON.stringify(log, null, 2)}`);
  console.log(`\nwrote ${path}`);
  for (const check of log.verdict.checks) {
    console.log(`  ${check.met ? 'met' : 'MISSED'}  ${check.name}: ${check.actual}`);
  }
  return log.verdict.met;
}

async function run(config: HarnessConfig, sql: SqlClient, lock: HeldLock): Promise<boolean> {
  const startedAt = new Date();
  // Read here and not after the window: the two fields describe the tree at `startedAt`, and a
  // tree git cannot read refuses the run now rather than after a completed fan-out.
  const provenance = await gitProvenance();
  const peak = peakInstant(TARGET_DATE);

  // 1. The seed is present and its peak really is one peak. `verifyPeak` is the seed's own query,
  //    so this is not a second count that could drift from it.
  const verifyRows = await verifyPeak(sql, TARGET_DATE);
  console.log(`seed verification for ${TARGET_DATE}:`);
  console.log(formatVerifyRows(verifyRows));
  const verified = Object.fromEntries(verifyRows.map((row) => [row.key, row.value]));
  if (Number(verified.reminders_at_peak) !== PEAK_USER_COUNT) {
    throw new Error(
      `refusing to run: the peak instant carries ${verified.reminders_at_peak ?? 'no'} reminders, ` +
        `expected ${PEAK_USER_COUNT}. Run \`bun run db:seed\` first.`,
    );
  }

  // 2. The initial condition, then the assertion that the window is the peak alone.
  const prePeakMarkedSent = await markPrePeakSent(sql, peak);
  console.log(`\nmarked ${prePeakMarkedSent} pre-peak reminders sent (they are not this run's)`);
  const due = await dueAtPeak(sql, peak);
  if (due.due_pending !== PEAK_USER_COUNT || due.due_at_peak !== due.due_pending) {
    throw new Error(
      `refusing to run: ${due.due_pending} reminders are due and pending at the peak instant ` +
        `(${due.due_at_peak} of them on it), expected exactly ${PEAK_USER_COUNT} on it and ` +
        'nothing else. A database that has already been measured must be re-seeded: ' +
        'run `bun run db:seed`.',
    );
  }
  console.log(`${due.due_at_peak} reminders due and pending at ${peak.toISOString()}`);

  const maxConnections = await readMaxConnections(sql);

  // 3. The API-load pool, and the measurement inside one `finally` that deletes it.
  return withApiLoadPool(
    { create: () => createPool(config, sql, lock), remove: () => deletePool(sql, lock) },
    (pool) =>
      measure({
        config,
        sql,
        peak,
        startedAt,
        provenance,
        seed: { targetDate: TARGET_DATE, peakInstant: peak, verified, prePeakMarkedSent },
        remindersAtPeak: due.due_at_peak,
        maxConnections,
        pool,
      }),
  );
}

if (import.meta.main) {
  const config = readHarnessConfig(process.env);
  const sql = createSqlClient(config.databaseUrl);
  let met = false;
  try {
    // The lock encloses everything `run` does, the pool delete in its `finally` included, so no
    // second harness can touch this database between the first write and the last cleanup.
    met = await withRunLock(runLockOnDatabase(sql), (lock) => run(config, sql, lock));
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await sql.end();
  }
  if (!met) process.exit(1);
}
