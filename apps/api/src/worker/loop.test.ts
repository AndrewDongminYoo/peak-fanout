import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  CardsReadError,
  messageFor,
  type CardsService,
  type ExpressionCard,
} from '../cards/service';
import { PushSendError, type PushMessage, type PushSink } from '../push/sink';
import { REMINDER_MESSAGE } from '../scheduler/tick';
import {
  decideFailure,
  describeSendFailure,
  firstFailure,
  formatBatchLine,
  formatShutdownLine,
  installShutdownHandlers,
  longestBackoffMs,
  readWorkerConfig,
  runWorkerLoop,
  sleepUnlessStopped,
  WORKER_DEFAULTS,
  WORKER_INT_MAX,
  type JobsRepository,
  type RetryPolicy,
  type SendOutcome,
  type ShutdownSignal,
  type SignalTarget,
  type WorkerLoopDeps,
} from './loop';

/** The database's `now()` for every fake statement below: one instant, so arithmetic is exact. */
const NOW = new Date('2026-09-15T12:00:00.000Z');

/** What every fake reminder is scheduled for and where: the peak, in the peak's timezone. */
const SCHEDULED_AT = NOW;
const TIMEZONE = 'Asia/Seoul';

type JobRow = {
  id: string;
  reminderId: string;
  attempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  deadAt: Date | null;
  doneAt: Date | null;
};

type ReminderState = 'queued' | 'sent' | 'failed';

type DeliveryRow = {
  reminderId: string;
  status: 'sent' | 'failed';
  latencyMs: number;
  error: string | null;
};

type SeedJob = {
  id: string;
  reminderId: string;
  attempts?: number;
  /** The user's ordered tokens; none for a seeded user, which is the measured population. */
  pushTokens?: string[];
  /** False for a job whose reminder row is gone: the claim's second select finds nothing for it. */
  reminderExists?: boolean;
};

/**
 * Jobs, reminders and deliveries in memory, under the semantics of the Drizzle repository's
 * statements: the claim takes open, due rows whose lock is null or older than the lease; the
 * completion moves only a `queued` reminder and stamps `done_at` only once; a failure decides
 * retry or dead-letter from the row's own `attempts` as it stands then, and leaves a done job
 * alone; a retry releases the lock and moves `run_at` by the backoff; a dead-letter stamps
 * `dead_at` and `done_at`.
 */
function createMemoryJobs(seed: SeedJob[]) {
  const jobRows = new Map<string, JobRow>();
  const reminderRows = new Map<string, ReminderState>();
  const pushTokens = new Map<string, string[]>();
  const orphans = new Set<string>();
  for (const job of seed) {
    if (job.reminderExists === false) orphans.add(job.id);
    jobRows.set(job.id, {
      id: job.id,
      reminderId: job.reminderId,
      attempts: job.attempts ?? 0,
      runAt: NOW,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      deadAt: null,
      doneAt: null,
    });
    reminderRows.set(job.reminderId, 'queued');
    pushTokens.set(job.reminderId, job.pushTokens ?? []);
  }
  const deliveries: DeliveryRow[] = [];
  const calls = {
    claim: [] as Array<{ batchSize: number; workerId: string; leaseMs: number }>,
    complete: [] as string[],
    retryOrDeadLetter: [] as Array<{ outcomes: readonly SendOutcome[]; policy: RetryPolicy }>,
  };

  const repository: JobsRepository = {
    async claim(batchSize, workerId, leaseMs) {
      calls.claim.push({ batchSize, workerId, leaseMs });
      const staleBefore = new Date(NOW.getTime() - leaseMs);
      const open = [...jobRows.values()]
        .filter(
          (row) =>
            row.doneAt === null &&
            row.runAt <= NOW &&
            (row.lockedAt === null || row.lockedAt < staleBefore),
        )
        .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
        .slice(0, batchSize);
      for (const row of open) {
        row.lockedAt = NOW;
        row.lockedBy = workerId;
      }
      return open.map((row) => ({
        id: row.id,
        reminderId: row.reminderId,
        reminder: orphans.has(row.id)
          ? null
          : {
              pushTokens: pushTokens.get(row.reminderId) ?? [],
              timezone: TIMEZONE,
              scheduledAt: SCHEDULED_AT,
            },
      }));
    },
    async complete(job, sends) {
      calls.complete.push(job.id);
      for (const { latencyMs } of sends) {
        deliveries.push({ reminderId: job.reminderId, status: 'sent', latencyMs, error: null });
      }
      const moved = reminderRows.get(job.reminderId) === 'queued';
      if (moved) reminderRows.set(job.reminderId, 'sent');
      const row = jobRows.get(job.id);
      if (row && row.doneAt === null) row.doneAt = NOW;
      return moved ? 'recorded' : 'reminder_not_queued';
    },
    async retryOrDeadLetter(job, outcomes, policy) {
      calls.retryOrDeadLetter.push({ outcomes, policy });
      // Every send of the attempt is a row, the ones that succeeded included; the job is decided
      // from the first failure (design.md "Send targets", "Retry, backoff, dead-letter").
      const failure = firstFailure(outcomes);
      for (const outcome of outcomes) {
        deliveries.push({
          reminderId: job.reminderId,
          status: outcome.status,
          latencyMs: outcome.latencyMs,
          error: outcome.status === 'failed' ? outcome.error : null,
        });
      }
      const row = jobRows.get(job.id);
      if (!row || row.doneAt !== null) return 'job_done';
      const outcome = decideFailure(row.attempts, policy);
      row.attempts = outcome.attempts;
      row.lastError = failure.error;
      if (outcome.kind === 'retry') {
        row.runAt = new Date(NOW.getTime() + outcome.backoffMs);
        row.lockedAt = null;
        return 'retry';
      }
      row.deadAt = NOW;
      row.doneAt = NOW;
      if (reminderRows.get(job.reminderId) === 'queued') reminderRows.set(job.reminderId, 'failed');
      return 'dead_letter';
    },
  };

  return { repository, jobRows, reminderRows, deliveries, calls };
}

type SinkCall = { token: string | null; message: PushMessage };

/**
 * A sink that records how many sends are in flight at once. With `gated`, every send waits on a
 * gate the test releases, so the peak can be read while the batch is still in the air.
 */
function fakeSink(behavior: (call: number) => number | Error, gated = false) {
  const calls: SinkCall[] = [];
  const gates: Array<() => void> = [];
  let inFlight = 0;
  let peak = 0;
  const sink: PushSink = {
    async send(token, message) {
      calls.push({ token, message });
      const call = calls.length;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      if (gated) await new Promise<void>((resolve) => gates.push(resolve));
      inFlight -= 1;
      const outcome = behavior(call);
      if (outcome instanceof Error) throw outcome;
      return { latencyMs: outcome };
    },
  };
  const release = () => {
    for (const open of gates.splice(0)) open();
  };
  return { sink, calls, gates, release, peak: () => peak };
}

/**
 * A cards service that answers every read with the same cards and records what it was asked for.
 * The default answers with none, so the sink is handed the M1 copy, as a database seeded without
 * expressions would have it.
 */
function fakeCards(cards: ExpressionCard[] = [], fail?: Error) {
  const reads: Array<{ instant: Date; timezone: string }> = [];
  const service: Pick<CardsService, 'todayFor'> = {
    async todayFor(instant, timezone) {
      reads.push({ instant, timezone });
      if (fail) throw fail;
      return { date: '2026-09-15', cards };
    },
  };
  return { service, reads };
}

const card = (position: number): ExpressionCard => ({
  position,
  lang: 'en',
  text: `expression ${position}`,
  translation: `translation ${position}`,
  level: 1,
});

/** What the service throws when the database fails under a read: the one throw that trips the breaker. */
const readFailure = (message: string) => new CardsReadError('2026-09-15', new Error(message));

/** How the loop's skip line renders `readFailure(message)`. */
const readFailureLine = (id: string, message: string) =>
  `skipped job ${id}: cards read failed: CardsReadError: cards for 2026-09-15: Error: ${message}`;

const BREAKER_OPEN_LINE =
  'cards read failed: not claiming until a probe of that read succeeds, one per poll';

/** Yield to the event loop until `condition` holds, or fail rather than hang. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let turn = 0; turn < 200; turn += 1) {
    if (condition()) return;
    await Bun.sleep(0);
  }
  throw new Error(`gave up waiting for ${what}`);
}

/**
 * Loop deps with the fakes wired in. The default `sleep` is what stops a test: an empty claim
 * means the fake rows are exhausted, so the first idle sleep requests shutdown, and the loop
 * returns once it sees the signal.
 */
function deps(
  repository: JobsRepository,
  sink: PushSink,
  overrides: Partial<WorkerLoopDeps> = {},
): { deps: WorkerLoopDeps; controller: AbortController; lines: string[]; sleeps: number[] } {
  const controller = new AbortController();
  const lines: string[] = [];
  const sleeps: number[] = [];
  return {
    controller,
    lines,
    sleeps,
    deps: {
      jobs: repository,
      cards: fakeCards().service,
      sink,
      workerId: 'test-host:1',
      config: WORKER_DEFAULTS,
      clock: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
        controller.abort();
      },
      shutdown: controller.signal,
      log: (line) => lines.push(line),
      ...overrides,
    },
  };
}

const job = (id: string, attempts = 0, pushTokens: string[] = []): SeedJob => ({
  id,
  reminderId: `r-${id}`,
  attempts,
  pushTokens,
});

/** The `retryOrDeadLetter` argument for a job with one target whose one send failed. */
const oneFailure = (latencyMs: number, error: string): SendOutcome[] => [
  { status: 'failed', latencyMs, error },
];

describe('runWorkerLoop', () => {
  it('sends a claimed batch concurrently and records each outcome exactly once', async () => {
    const queue = createMemoryJobs([job('a'), job('b'), job('c')]);
    const { sink, gates, release, peak } = fakeSink(() => 70, true);
    const wired = deps(queue.repository, sink);

    const loop = runWorkerLoop(wired.deps);
    await waitFor(() => gates.length === 3, 'all three sends to be in flight');
    // The whole point of the batch: every send was started before any was awaited.
    expect(peak()).toBe(3);
    expect(peak()).toBeGreaterThan(1);
    release();
    const summary = await loop;

    expect(queue.calls.complete.sort()).toEqual(['a', 'b', 'c']);
    expect(queue.calls.retryOrDeadLetter).toEqual([]);
    expect([...queue.reminderRows.values()]).toEqual(['sent', 'sent', 'sent']);
    expect([...queue.jobRows.values()].every((row) => row.doneAt !== null)).toBe(true);
    expect(queue.deliveries).toHaveLength(3);
    expect(queue.deliveries.every((row) => row.status === 'sent' && row.latencyMs === 70)).toBe(
      true,
    );
    expect(summary).toMatchObject({ batches: 1, claimed: 3, sent: 3, failed: 0, dead: 0 });
    expect(wired.lines).toEqual([
      'batch claimed=3 sent=3 failed=0 dead=0 duplicate=0 skipped=0 elapsed=0.00s',
    ]);
  });

  it('claims with its own id, the configured batch size and the lease', async () => {
    const queue = createMemoryJobs([job('a')]);
    const { sink } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, {
      config: { ...WORKER_DEFAULTS, batchSize: 7, leaseMs: 9_000 },
    });

    await runWorkerLoop(wired.deps);

    expect(queue.calls.claim[0]).toEqual({ batchSize: 7, workerId: 'test-host:1', leaseMs: 9_000 });
    expect(queue.jobRows.get('a')?.lockedBy).toBe('test-host:1');
  });

  it('hands the sink the reminder’s token as stored, and the M1 copy when there are no cards', async () => {
    const queue = createMemoryJobs([job('a', 0, ['ExponentPushToken[abc]']), job('b')]);
    const { sink, calls } = fakeSink(() => 60);

    await runWorkerLoop(deps(queue.repository, sink).deps);

    // Sends start in claim order, synchronously, so the call order is the batch order; a user
    // with no token is exactly one send to null (design.md "Send targets").
    expect(calls.map((call) => call.token)).toEqual(['ExponentPushToken[abc]', null]);
    expect(calls.every((call) => call.message === REMINDER_MESSAGE)).toBe(true);
    expect(queue.deliveries).toEqual([
      { reminderId: 'r-a', status: 'sent', latencyMs: 60, error: null },
      { reminderId: 'r-b', status: 'sent', latencyMs: 60, error: null },
    ]);
  });

  it('sends to every token of a user at once, in the order they were read, one sent row each', async () => {
    // design.md "Send targets": two registered installations are two sends through the same
    // sink, started before either is awaited, and two `sent` rows each carrying its own cost;
    // the job is still one completion and one `sent` on the batch line.
    const queue = createMemoryJobs([
      job('a', 0, ['ExponentPushToken[older]', 'ExponentPushToken[newer]']),
    ]);
    const { sink, calls, gates, release, peak } = fakeSink((call) => 60 + call, true);
    const wired = deps(queue.repository, sink);

    const loop = runWorkerLoop(wired.deps);
    await waitFor(() => gates.length === 2, 'both sends to be in flight');
    expect(peak()).toBe(2);
    release();
    const summary = await loop;

    expect(calls.map((call) => call.token)).toEqual([
      'ExponentPushToken[older]',
      'ExponentPushToken[newer]',
    ]);
    expect(queue.calls.complete).toEqual(['a']);
    expect(queue.deliveries).toEqual([
      { reminderId: 'r-a', status: 'sent', latencyMs: 61, error: null },
      { reminderId: 'r-a', status: 'sent', latencyMs: 62, error: null },
    ]);
    expect(queue.reminderRows.get('r-a')).toBe('sent');
    expect(summary).toMatchObject({ claimed: 1, sent: 1, failed: 0, dead: 0 });
    expect(wired.lines[0]).toBe(
      'batch claimed=1 sent=1 failed=0 dead=0 duplicate=0 skipped=0 elapsed=0.00s',
    );
  });

  it('records a mixed attempt as one sent row and one failed row, and retries the whole job', async () => {
    // One of two sends failed: both are written down with their own cost, the job is retried
    // from the failure, and the retry will re-send to both targets (design.md "Retry, backoff,
    // dead-letter" documents that duplicate rather than preventing it).
    const queue = createMemoryJobs([
      job('a', 0, ['ExponentPushToken[older]', 'ExponentPushToken[newer]']),
    ]);
    const { sink } = fakeSink((call) => (call === 2 ? new PushSendError('nope', 30) : 80));
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.calls.retryOrDeadLetter).toEqual([
      {
        outcomes: [
          { status: 'sent', latencyMs: 80 },
          { status: 'failed', latencyMs: 30, error: 'PushSendError: nope' },
        ],
        policy: WORKER_DEFAULTS,
      },
    ]);
    expect(queue.calls.complete).toEqual([]);
    expect(queue.deliveries).toEqual([
      { reminderId: 'r-a', status: 'sent', latencyMs: 80, error: null },
      { reminderId: 'r-a', status: 'failed', latencyMs: 30, error: 'PushSendError: nope' },
    ]);
    expect(queue.jobRows.get('a')).toMatchObject({
      attempts: 1,
      runAt: new Date('2026-09-15T12:00:01.000Z'),
      lockedAt: null,
      doneAt: null,
      lastError: 'PushSendError: nope',
    });
    expect(queue.reminderRows.get('r-a')).toBe('queued');
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1, dead: 0 });
    expect(wired.lines[0]).toBe(
      'batch claimed=1 sent=0 failed=1 dead=0 duplicate=0 skipped=0 elapsed=0.00s',
    );
  });

  it('reads each reminder’s cards for its own date and zone before the send, and sends them', async () => {
    // design.md "The worker reads the cards": the read is per send, keyed by the reminder's
    // scheduled_at in the user's timezone, and the message the sink is handed is built from it.
    const queue = createMemoryJobs([job('a'), job('b')]);
    const cards = fakeCards([card(1), card(2), card(3)]);
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards: cards.service });

    const summary = await runWorkerLoop(wired.deps);

    expect(cards.reads).toEqual([
      { instant: SCHEDULED_AT, timezone: TIMEZONE },
      { instant: SCHEDULED_AT, timezone: TIMEZONE },
    ]);
    expect(calls.map((call) => call.message)).toEqual([
      messageFor([card(1), card(2), card(3)]),
      messageFor([card(1), card(2), card(3)]),
    ]);
    expect(calls[0]?.message).toEqual({
      title: '3 expressions are waiting',
      body: 'expression 1 · expression 2 · expression 3',
    });
    expect(summary).toMatchObject({ claimed: 2, sent: 2, skipped: 0 });
  });

  it('skips a job whose card read throws: no send, nothing recorded, the job left for the lease', async () => {
    // A read that throws is not a failed send (design.md "The worker reads the cards"): the sink
    // is not called, no deliveries row is written, attempts does not move, and the job stays
    // claimed — locked in this worker's name, done_at null — for the lease to hand on. The batch
    // line says skipped, and the loop goes on rather than treating it as a recording error.
    const queue = createMemoryJobs([job('a'), job('b')]);
    const cards = fakeCards([], readFailure('connection refused'));
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards: cards.service });

    const summary = await runWorkerLoop(wired.deps);

    // Two reads for the batch, and a third: the probe that follows the batch, before any sleep.
    expect(cards.reads).toHaveLength(3);
    expect(calls).toEqual([]);
    expect(queue.calls.complete).toEqual([]);
    expect(queue.calls.retryOrDeadLetter).toEqual([]);
    expect(queue.deliveries).toEqual([]);
    for (const id of ['a', 'b']) {
      expect(queue.jobRows.get(id)).toMatchObject({
        attempts: 0,
        lockedBy: 'test-host:1',
        lockedAt: NOW,
        doneAt: null,
        deadAt: null,
        lastError: null,
      });
      expect(queue.reminderRows.get(`r-${id}`)).toBe('queued');
    }
    expect(summary).toMatchObject({
      batches: 1,
      claimed: 2,
      sent: 0,
      failed: 0,
      dead: 0,
      duplicate: 0,
      skipped: 2,
    });
    expect(wired.lines).toEqual([
      readFailureLine('a', 'connection refused'),
      readFailureLine('b', 'connection refused'),
      'batch claimed=2 sent=0 failed=0 dead=0 duplicate=0 skipped=2 elapsed=0.00s',
      BREAKER_OPEN_LINE,
    ]);
    expect(formatShutdownLine(summary)).toBe(
      'stopped: nothing in flight; batches=1 claimed=2 sent=0 failed=0 dead=0 duplicate=0 skipped=2',
    );
    // A read failed at the database, so the worker claims nothing more: one claim, the probe,
    // then the poll sleep that stops this test.
    expect(queue.calls.claim).toHaveLength(1);
    expect(wired.sleeps).toEqual([WORKER_DEFAULTS.pollMs]);
  });

  it('claims nothing more while its reads keep failing: one batch held, one probe per poll', async () => {
    // A worker whose card reads fail costs itself no send per job, so a sleep between claims
    // only sets the rate at which it locks the due queue: 100 due jobs would be under its lease
    // within four polls, hidden from the workers that can send until the lease expired. So a
    // read failure stops the claims: the one batch of 25 it holds waits out the lease as a killed
    // worker's would, and every poll after it is a probe of the read that failed, not a claim.
    // The default sleep aborts on the first call, so a test that reaches a second poll has to
    // count its own; this one lets four polls pass.
    const queue = createMemoryJobs(Array.from({ length: 100 }, (_, i) => job(`j${i}`)));
    const cards = fakeCards([], readFailure('relation "expressions" does not exist'));
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards: cards.service });
    wired.deps.sleep = async (ms) => {
      wired.sleeps.push(ms);
      if (wired.sleeps.length === 4) wired.controller.abort();
    };

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.calls.claim).toHaveLength(1);
    expect(wired.sleeps).toEqual(Array(4).fill(WORKER_DEFAULTS.pollMs));
    // 25 reads for the batch, then one probe before each of the four sleeps, all for the first
    // skipped job's instant and zone.
    expect(cards.reads).toHaveLength(WORKER_DEFAULTS.batchSize + 4);
    expect(cards.reads.slice(WORKER_DEFAULTS.batchSize)).toEqual(
      Array(4).fill({ instant: SCHEDULED_AT, timezone: TIMEZONE }),
    );
    expect(calls).toEqual([]);
    const locked = [...queue.jobRows.values()].filter((row) => row.lockedBy !== null);
    expect(locked).toHaveLength(WORKER_DEFAULTS.batchSize);
    expect(summary).toMatchObject({ batches: 1, claimed: 25, sent: 0, skipped: 25 });
    expect(wired.lines.slice(WORKER_DEFAULTS.batchSize)).toEqual([
      'batch claimed=25 sent=0 failed=0 dead=0 duplicate=0 skipped=25 elapsed=0.00s',
      BREAKER_OPEN_LINE,
    ]);
  });

  it('claims again once a probe succeeds, and sends what it claims', async () => {
    // The read recovers during the third poll: the probe before the third sleep still fails,
    // the one before the fourth succeeds, and the worker goes back to the queue. The batch it
    // held stays locked in its name — the lease, not this worker, hands it on — so the second
    // claim takes the five jobs the first left, and they go out.
    const queue = createMemoryJobs(Array.from({ length: 30 }, (_, i) => job(`j${i}`)));
    const reads: Array<{ instant: Date; timezone: string }> = [];
    let failing = true;
    const cards: Pick<CardsService, 'todayFor'> = {
      async todayFor(instant, timezone) {
        reads.push({ instant, timezone });
        if (failing) throw readFailure('connection refused');
        return { date: '2026-09-15', cards: [card(7)] };
      },
    };
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards });
    wired.deps.sleep = async (ms) => {
      wired.sleeps.push(ms);
      if (wired.sleeps.length === 2) failing = false;
      if (wired.sleeps.length === 3) wired.controller.abort();
    };

    const summary = await runWorkerLoop(wired.deps);

    // Claim, probe, sleep, probe, sleep, probe (succeeds), claim, claim (empty), sleep.
    expect(queue.calls.claim).toHaveLength(3);
    expect(wired.sleeps).toEqual(Array(3).fill(WORKER_DEFAULTS.pollMs));
    expect(reads).toHaveLength(25 + 3 + 5);
    expect(calls).toHaveLength(5);
    expect(queue.calls.complete.sort()).toEqual(['j25', 'j26', 'j27', 'j28', 'j29']);
    const held = [...queue.jobRows.values()].filter(
      (row) => row.lockedBy === 'test-host:1' && row.doneAt === null,
    );
    expect(held).toHaveLength(25);
    expect(summary).toMatchObject({ batches: 2, claimed: 30, sent: 5, skipped: 25 });
    expect(wired.lines.slice(25)).toEqual([
      'batch claimed=25 sent=0 failed=0 dead=0 duplicate=0 skipped=25 elapsed=0.00s',
      BREAKER_OPEN_LINE,
      'cards read recovered after 3 probes: claiming again',
      'batch claimed=5 sent=5 failed=0 dead=0 duplicate=0 skipped=0 elapsed=0.00s',
    ]);
  });

  it('honours a shutdown request that arrives during a probe before claiming again', async () => {
    // Both outcomes of a probe go back to the top of the loop, so a request that landed while
    // the probe was in flight is seen there: a probe that succeeds must not fall through to a
    // claim the operator asked it not to make.
    const queue = createMemoryJobs([job('a'), job('b'), job('c')]);
    let reads = 0;
    const cards: Pick<CardsService, 'todayFor'> = {
      async todayFor() {
        reads += 1;
        if (reads <= 3) throw readFailure('connection refused');
        wired.controller.abort();
        return { date: '2026-09-15', cards: [] };
      },
    };
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, {
      cards,
      // Never reached: the probe succeeds, so nothing sleeps, and shutdown stops the loop.
      sleep: async () => {
        throw new Error('slept after a shutdown request');
      },
    });

    const summary = await runWorkerLoop(wired.deps);

    expect(reads).toBe(4);
    expect(queue.calls.claim).toHaveLength(1);
    expect(calls).toEqual([]);
    expect(summary).toMatchObject({ batches: 1, claimed: 3, skipped: 3, drained: 0 });
    expect(wired.lines.at(-1)).toBe('cards read recovered after 1 probe: claiming again');
  });

  it('lets a probe that fails for a reason other than the read release the breaker', async () => {
    // Only a read failure holds the breaker. The input was read once already — the failure that
    // tripped it came from the database, past the date step — so a probe that throws anything
    // else is not the outage the breaker waits out; the worker claims again and that job, if it
    // is claimed again, is skipped on its own.
    const queue = createMemoryJobs([job('a')]);
    let reads = 0;
    const cards: Pick<CardsService, 'todayFor'> = {
      async todayFor() {
        reads += 1;
        if (reads === 1) throw readFailure('connection refused');
        throw new RangeError('Invalid time zone specified: Asia/Seoul');
      },
    };
    const { sink } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards });

    const summary = await runWorkerLoop(wired.deps);

    // Claim, probe (released), claim (the job is still locked: empty), sleep.
    expect(reads).toBe(2);
    expect(queue.calls.claim).toHaveLength(2);
    expect(wired.sleeps).toEqual([WORKER_DEFAULTS.pollMs]);
    expect(summary).toMatchObject({ batches: 1, claimed: 1, skipped: 1 });
    expect(wired.lines.at(-1)).toBe('cards read recovered after 1 probe: claiming again');
  });

  it('keeps claiming past a batch of orphans, and never probes for one', async () => {
    // An orphan's skip is not a read failure: nothing was read, so there is nothing to probe,
    // and the worker goes back to the queue. A batch skipped whole by orphans sent nothing, so
    // it takes the poll sleep an empty claim gets, and the next poll claims: three orphans, one
    // claim that locks them, the sleep, a second claim that finds nothing, and the sleep that
    // stops the test.
    const queue = createMemoryJobs([
      { ...job('a'), reminderExists: false },
      { ...job('b'), reminderExists: false },
      { ...job('c'), reminderExists: false },
    ]);
    const cards = fakeCards([card(7)]);
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards: cards.service });
    wired.deps.sleep = async (ms) => {
      wired.sleeps.push(ms);
      if (wired.sleeps.length === 2) wired.controller.abort();
    };

    const summary = await runWorkerLoop(wired.deps);

    expect(cards.reads).toEqual([]);
    expect(calls).toEqual([]);
    expect(queue.calls.claim).toHaveLength(2);
    expect(wired.sleeps).toEqual([WORKER_DEFAULTS.pollMs, WORKER_DEFAULTS.pollMs]);
    expect(summary).toMatchObject({ batches: 1, claimed: 3, skipped: 3 });
    expect(wired.lines).toEqual([
      'skipped job a: reminder r-a no longer exists',
      'skipped job b: reminder r-b no longer exists',
      'skipped job c: reminder r-c no longer exists',
      'batch claimed=3 sent=0 failed=0 dead=0 duplicate=0 skipped=3 elapsed=0.00s',
    ]);
  });

  it('skips a job the service refuses before any read — an unknown timezone — without stopping the claims', async () => {
    // A throw the service does not name as the read's is that reminder's own (design.md "The
    // worker reads the cards"): the row is reclaimed once per lease and skipped each time, as
    // before, and the worker beside it keeps claiming. Were this to trip the breaker, its probe
    // — the same read, for the same zone — would fail for as long as the row stood, and one row
    // would idle every worker that ever claimed it.
    const queue = createMemoryJobs([job('a'), job('b')]);
    const reads: string[] = [];
    const cards: Pick<CardsService, 'todayFor'> = {
      async todayFor(_instant, timezone) {
        reads.push(timezone);
        if (reads.length === 1) throw new RangeError('Invalid time zone specified: Mars/Olympus');
        return { date: '2026-09-15', cards: [card(7)] };
      },
    };
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards });

    const summary = await runWorkerLoop(wired.deps);

    // Two reads for the batch and none after it: no probe. Then the empty claim and its sleep.
    expect(reads).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(queue.calls.claim).toHaveLength(2);
    expect(wired.sleeps).toEqual([WORKER_DEFAULTS.pollMs]);
    expect(summary).toMatchObject({ batches: 1, claimed: 2, sent: 1, skipped: 1 });
    expect(wired.lines).toEqual([
      'skipped job a: cards read failed: RangeError: Invalid time zone specified: Mars/Olympus',
      'batch claimed=2 sent=1 failed=0 dead=0 duplicate=0 skipped=1 elapsed=0.00s',
    ]);
  });

  it('skips a job whose reminder no longer exists, by name, and sends the rest of the batch', async () => {
    // The orphan a re-seed's sweep removes: the claim's second select found no row for it, so
    // the repository hands it over with `reminder: null` and the loop skips it before any read
    // or send — nothing is pushed to nobody, nothing is recorded against a row that is gone,
    // and the job beside it goes out. One orphan costs one job, not the batch.
    const queue = createMemoryJobs([{ ...job('a'), reminderExists: false }, job('b')]);
    const cards = fakeCards([card(7)]);
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards: cards.service });

    const summary = await runWorkerLoop(wired.deps);

    expect(cards.reads).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(queue.calls.complete).toEqual(['b']);
    expect(queue.calls.retryOrDeadLetter).toEqual([]);
    expect(queue.deliveries).toEqual([
      { reminderId: 'r-b', status: 'sent', latencyMs: 60, error: null },
    ]);
    expect(queue.jobRows.get('a')).toMatchObject({
      attempts: 0,
      lockedBy: 'test-host:1',
      lockedAt: NOW,
      doneAt: null,
      lastError: null,
    });
    expect(summary).toMatchObject({ claimed: 2, sent: 1, failed: 0, duplicate: 0, skipped: 1 });
    expect(wired.lines).toEqual([
      'skipped job a: reminder r-a no longer exists',
      'batch claimed=2 sent=1 failed=0 dead=0 duplicate=0 skipped=1 elapsed=0.00s',
    ]);
  });

  it('skips only the job whose read threw and sends the rest of the batch', async () => {
    const queue = createMemoryJobs([job('a'), job('b')]);
    let reads = 0;
    const cards: Pick<CardsService, 'todayFor'> = {
      async todayFor() {
        reads += 1;
        if (reads === 1) throw readFailure('replica gone');
        return { date: '2026-09-15', cards: [card(7)] };
      },
    };
    const { sink, calls } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, { cards });

    const summary = await runWorkerLoop(wired.deps);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toEqual({ title: '1 expression is waiting', body: 'expression 7' });
    expect(queue.calls.complete).toEqual(['b']);
    expect(queue.jobRows.get('a')).toMatchObject({ doneAt: null, lockedBy: 'test-host:1' });
    expect(summary).toMatchObject({ claimed: 2, sent: 1, failed: 0, skipped: 1 });
    // One read failed, so the batch trips the breaker even though the rest of it went out: a
    // worker that can read one key from its cache and not another from the database would
    // otherwise lock the second key's jobs on every claim. The probe that follows succeeds —
    // the failure was one read's — and the worker claims again at once; the empty claim sleeps.
    expect(wired.lines).toEqual([
      readFailureLine('a', 'replica gone'),
      'batch claimed=2 sent=1 failed=0 dead=0 duplicate=0 skipped=1 elapsed=0.00s',
      BREAKER_OPEN_LINE,
      'cards read recovered after 1 probe: claiming again',
    ]);
    expect(reads).toBe(3);
    expect(queue.calls.claim).toHaveLength(2);
    expect(wired.sleeps).toEqual([WORKER_DEFAULTS.pollMs]);
  });

  it('reschedules a failed send one backoff later and releases the lock', async () => {
    const queue = createMemoryJobs([job('a')]);
    const { sink } = fakeSink(() => new PushSendError('simulated push failure after 90ms', 90));
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    // The repository is handed what the send cost and said, and the policy to decide with; the
    // decision itself is its own, from the row.
    expect(queue.calls.retryOrDeadLetter).toEqual([
      {
        outcomes: oneFailure(90, 'PushSendError: simulated push failure after 90ms'),
        policy: WORKER_DEFAULTS,
      },
    ]);
    const row = queue.jobRows.get('a');
    expect(row).toMatchObject({
      attempts: 1,
      // design.md "Retry, backoff, dead-letter": now() + 1,000 ms x 2^0 after the first failure.
      runAt: new Date('2026-09-15T12:00:01.000Z'),
      lockedAt: null,
      doneAt: null,
      deadAt: null,
      lastError: 'PushSendError: simulated push failure after 90ms',
    });
    expect(queue.reminderRows.get('r-a')).toBe('queued');
    // The failed attempt is still one deliveries row, with what the sink said it cost.
    expect(queue.deliveries).toEqual([
      {
        reminderId: 'r-a',
        status: 'failed',
        latencyMs: 90,
        error: 'PushSendError: simulated push failure after 90ms',
      },
    ]);
    expect(queue.calls.complete).toEqual([]);
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1, dead: 0 });
    expect(wired.lines[0]).toBe(
      'batch claimed=1 sent=0 failed=1 dead=0 duplicate=0 skipped=0 elapsed=0.00s',
    );
  });

  it('doubles the backoff on the second failure', async () => {
    const queue = createMemoryJobs([job('a', 1)]);
    const { sink } = fakeSink(() => new PushSendError('nope', 55));

    await runWorkerLoop(deps(queue.repository, sink).deps);

    expect(queue.jobRows.get('a')).toMatchObject({
      attempts: 2,
      runAt: new Date('2026-09-15T12:00:02.000Z'),
      lockedAt: null,
      doneAt: null,
    });
  });

  it('decides retry or dead-letter from the row as it stands, not from the count the claim read', async () => {
    // The row was at 1 when claimed. While this send is in the air another worker, holding the
    // same job after a lease reclaim, fails it and writes attempts = 2. This failure has to see
    // that write and dead-letter; deciding from the claim-time count would write a retry and
    // leave the job open at the ceiling, to be sent a fourth time.
    const queue = createMemoryJobs([job('a', 1)]);
    const { sink } = fakeSink(() => {
      (queue.jobRows.get('a') as JobRow).attempts = 2;
      return new PushSendError('nope', 40);
    });
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.jobRows.get('a')).toMatchObject({ attempts: 3, deadAt: NOW, doneAt: NOW });
    expect(queue.reminderRows.get('r-a')).toBe('failed');
    expect(summary).toMatchObject({ claimed: 1, failed: 1, dead: 1 });
    expect(wired.lines[0]).toBe(
      'batch claimed=1 sent=0 failed=1 dead=1 duplicate=0 skipped=0 elapsed=0.00s',
    );
  });

  it('counts a failure whose job another worker has finished as a duplicate and moves nothing', async () => {
    // The other side of at-least-once: the send failed here after another worker had already
    // completed the reclaimed job. The failed send is one deliveries row; the job stays as the
    // other worker left it; and the batch line says duplicate, not failed, so an operator can
    // tell a job that will be retried from one that was already done.
    const queue = createMemoryJobs([job('a', 1)]);
    const { sink } = fakeSink(() => {
      const row = queue.jobRows.get('a') as JobRow;
      row.doneAt = NOW;
      queue.reminderRows.set('r-a', 'sent');
      return new PushSendError('too late', 40);
    });
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.jobRows.get('a')).toMatchObject({ attempts: 1, deadAt: null, lastError: null });
    expect(queue.reminderRows.get('r-a')).toBe('sent');
    expect(queue.deliveries).toEqual([
      { reminderId: 'r-a', status: 'failed', latencyMs: 40, error: 'PushSendError: too late' },
    ]);
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 0, dead: 0, duplicate: 1 });
    expect(wired.lines[0]).toBe(
      'batch claimed=1 sent=0 failed=0 dead=0 duplicate=1 skipped=0 elapsed=0.00s',
    );
  });

  it('dead-letters the attempt that reaches the ceiling and fails the reminder', async () => {
    const queue = createMemoryJobs([job('a', 2)]);
    const { sink } = fakeSink(() => new PushSendError('still no', 120));
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.calls.retryOrDeadLetter).toEqual([
      { outcomes: oneFailure(120, 'PushSendError: still no'), policy: WORKER_DEFAULTS },
    ]);
    expect(queue.jobRows.get('a')).toMatchObject({
      attempts: 3,
      deadAt: NOW,
      doneAt: NOW,
      lastError: 'PushSendError: still no',
    });
    expect(queue.reminderRows.get('r-a')).toBe('failed');
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1, dead: 1 });
    expect(wired.lines[0]).toBe(
      'batch claimed=1 sent=0 failed=1 dead=1 duplicate=0 skipped=0 elapsed=0.00s',
    );
    // Dead-lettered means done: the next claim does not hand it out again.
    expect(queue.calls.claim.length).toBe(2);
    expect(queue.calls.retryOrDeadLetter.length).toBe(1);
  });

  it('records a failure that carries no timing as costing zero, as the naive send does', async () => {
    const queue = createMemoryJobs([job('a')]);
    const { sink } = fakeSink(() => new Error('socket closed'));

    await runWorkerLoop(deps(queue.repository, sink).deps);

    expect(queue.calls.retryOrDeadLetter[0]?.outcomes).toEqual(
      oneFailure(0, 'Error: socket closed'),
    );
  });

  it('finishes the batch in flight after a shutdown request and does not claim again', async () => {
    const queue = createMemoryJobs([job('a'), job('b'), job('c')]);
    const { sink, gates, release } = fakeSink(() => 60, true);
    const wired = deps(queue.repository, sink, {
      // Never reached: shutdown arrives mid-batch, and the loop must stop without an idle sleep.
      sleep: async () => {
        throw new Error('slept after a shutdown request');
      },
    });

    const loop = runWorkerLoop(wired.deps);
    await waitFor(() => gates.length === 3, 'the batch to be in flight');
    wired.controller.abort();
    release();
    const summary = await loop;

    expect(queue.calls.claim.length).toBe(1);
    expect(queue.calls.complete.sort()).toEqual(['a', 'b', 'c']);
    expect(summary).toMatchObject({ claimed: 3, sent: 3, drained: 3 });
    expect(formatShutdownLine(summary)).toBe(
      'stopped: drained 3 in flight; batches=1 claimed=3 sent=3 failed=0 dead=0 duplicate=0 skipped=0',
    );
  });

  it('sleeps after an empty claim and claims again', async () => {
    const queue = createMemoryJobs([]);
    const { sink } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink);
    wired.deps.sleep = async (ms) => {
      wired.sleeps.push(ms);
      if (wired.sleeps.length === 1) {
        // A job arrives while the worker sleeps; the next claim has to see it.
        const arrived = createMemoryJobs([job('late')]);
        queue.jobRows.set('late', arrived.jobRows.get('late') as JobRow);
        queue.reminderRows.set('r-late', 'queued');
        return;
      }
      wired.controller.abort();
    };

    const summary = await runWorkerLoop(wired.deps);

    expect(wired.sleeps).toEqual([WORKER_DEFAULTS.pollMs, WORKER_DEFAULTS.pollMs]);
    expect(queue.calls.claim.length).toBe(3);
    expect(queue.calls.complete).toEqual(['late']);
    expect(summary).toMatchObject({ batches: 1, claimed: 1, sent: 1, drained: 0 });
    expect(formatShutdownLine(summary)).toBe(
      'stopped: nothing in flight; batches=1 claimed=1 sent=1 failed=0 dead=0 duplicate=0 skipped=0',
    );
  });

  it('hands its shutdown signal to the idle sleep, which is what lets the sleep cut itself short', async () => {
    const queue = createMemoryJobs([]);
    const { sink } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink, {
      // A poll sleep that never ends on its own: only the signal it was handed can get past it,
      // so the loop returns only if that signal is the one shutdown aborts.
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        }),
    });

    const loop = runWorkerLoop(wired.deps);
    await waitFor(() => queue.calls.claim.length === 1, 'the first, empty claim');
    wired.controller.abort();

    expect(await loop).toMatchObject({ batches: 0, claimed: 0, drained: 0 });
  });

  it('listens for shutdown once per idle poll and lets go of it after each, so idling retains nothing', async () => {
    // Idle is the worker's usual state, so whatever one empty poll leaves behind is multiplied by
    // every poll until shutdown. The process's wait must register its interest in the signal per
    // poll and release it per poll: one wait on a single long-lived promise, raced against every
    // sleep, would attach a reaction per poll and free none of them until the abort.
    const queue = createMemoryJobs([]);
    const { sink } = fakeSink(() => 60);
    const polls = 50;
    const wired = deps(queue.repository, sink, {
      sleep: sleepUnlessStopped,
      config: { ...WORKER_DEFAULTS, pollMs: 0 },
    });
    const signal = wired.controller.signal;
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      added.push(args[1]);
      return add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      removed.push(args[1]);
      return remove(...args);
    };
    wired.deps.jobs = {
      ...queue.repository,
      async claim(...args) {
        // Shutdown arrives during the claim after the last counted poll, so the sleep that
        // follows it sees an aborted signal and registers nothing.
        if (queue.calls.claim.length === polls) wired.controller.abort();
        return queue.repository.claim(...args);
      },
    };

    await runWorkerLoop(wired.deps);

    expect(queue.calls.claim).toHaveLength(polls + 1);
    // One listener per poll, and the one removed after each poll is the one that poll added.
    expect(added).toHaveLength(polls);
    expect(removed).toEqual(added);
    expect(new Set(added).size).toBe(polls);
  });

  it('reports a completion whose reminder is no longer queued instead of throwing', async () => {
    // The at-least-once case: another worker sent and recorded this reminder after a lease
    // reclaim, so `WHERE state = 'queued'` moved nothing. The push went out; that is written down.
    const queue = createMemoryJobs([job('a'), job('b')]);
    queue.reminderRows.set('r-a', 'sent');
    const { sink } = fakeSink(() => 60);
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.calls.complete.sort()).toEqual(['a', 'b']);
    expect(queue.deliveries.filter((row) => row.status === 'sent')).toHaveLength(2);
    expect(summary).toMatchObject({ claimed: 2, sent: 1, duplicate: 1, failed: 0 });
    expect(wired.lines[0]).toBe(
      'batch claimed=2 sent=1 failed=0 dead=0 duplicate=1 skipped=0 elapsed=0.00s',
    );
  });

  it('lets a recording error through only after the rest of the batch has settled', async () => {
    // Recording, not sending, failed: the send SUCCEEDED, so this must not become a failed
    // attempt (the `runTick` lesson), and the sibling still in flight must be recorded before
    // the error escapes, or a shutdown that raced it would leave a send nobody wrote down.
    const queue = createMemoryJobs([job('a'), job('b')]);
    const completeGates: Array<() => void> = [];
    const repository: JobsRepository = {
      ...queue.repository,
      async complete(jobToRecord, sends) {
        if (jobToRecord.id === 'a') throw new Error('write CONFLICT: connection terminated');
        await new Promise<void>((resolve) => completeGates.push(resolve));
        return queue.repository.complete(jobToRecord, sends);
      },
    };
    const { sink } = fakeSink(() => 60);
    const wired = deps(repository, sink);

    let outcome: 'pending' | 'settled' = 'pending';
    const loop = runWorkerLoop(wired.deps).finally(() => {
      outcome = 'settled';
    });
    await waitFor(() => completeGates.length === 1, "b's completion to be in progress");
    await Bun.sleep(0);
    expect(outcome).toBe('pending');
    (completeGates[0] as () => void)();

    await expect(loop).rejects.toThrow('write CONFLICT');
    expect(queue.calls.complete).toEqual(['b']);
    expect(queue.calls.retryOrDeadLetter).toEqual([]);
    expect(wired.lines[0]).toBe(
      'batch claimed=2 sent=1 failed=0 dead=0 duplicate=0 skipped=0 elapsed=0.00s',
    );
  });
});

describe('installShutdownHandlers', () => {
  /** An emitter with `once` and `off`, and a way to fire a signal and count what is still listening. */
  function fakeProcess() {
    const listeners = new Map<ShutdownSignal, Array<(signal: ShutdownSignal) => void>>();
    const target: SignalTarget = {
      once(signal, listener) {
        listeners.set(signal, [...(listeners.get(signal) ?? []), listener]);
      },
      off(signal, listener) {
        listeners.set(
          signal,
          (listeners.get(signal) ?? []).filter((l) => l !== listener),
        );
      },
    };
    return {
      target,
      /** Fire `signal` the way the runtime does for `once`: remove each listener, then call it. */
      emit(signal: ShutdownSignal) {
        const current = listeners.get(signal) ?? [];
        listeners.set(signal, []);
        for (const listener of current) listener(signal);
      },
      listening: (signal: ShutdownSignal) => (listeners.get(signal) ?? []).length,
    };
  }

  it('requests shutdown once on the first signal and removes the handler for the other signal too', () => {
    // SIGTERM then SIGINT: the second must reach the runtime's default and kill, which it only
    // does if nothing is listening for it any more. A `once` per signal would leave the SIGINT
    // listener installed after SIGTERM ran.
    const fake = fakeProcess();
    const lines: string[] = [];
    let requests = 0;
    installShutdownHandlers(
      fake.target,
      () => (requests += 1),
      (line) => lines.push(line),
    );
    expect(fake.listening('SIGTERM')).toBe(1);
    expect(fake.listening('SIGINT')).toBe(1);

    fake.emit('SIGTERM');

    expect(requests).toBe(1);
    expect(lines).toEqual([
      'SIGTERM: no more claims, finishing the batch in flight (a second signal kills)',
    ]);
    expect(fake.listening('SIGTERM')).toBe(0);
    expect(fake.listening('SIGINT')).toBe(0);
    // Nothing listens, so this reaches no handler: the runtime default would have killed here.
    fake.emit('SIGINT');
    expect(requests).toBe(1);
  });

  it('treats SIGINT first the same way', () => {
    const fake = fakeProcess();
    let requests = 0;
    installShutdownHandlers(
      fake.target,
      () => (requests += 1),
      () => {},
    );
    fake.emit('SIGINT');
    expect(requests).toBe(1);
    expect(fake.listening('SIGTERM')).toBe(0);
  });
});

describe('sleepUnlessStopped', () => {
  /** Counts what a wait adds to and removes from the signal, so a test can see what it left behind. */
  function watchListeners(signal: AbortSignal) {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args: Parameters<typeof add>) => {
      added.push(args[1]);
      return add(...args);
    };
    signal.removeEventListener = (...args: Parameters<typeof remove>) => {
      removed.push(args[1]);
      return remove(...args);
    };
    return { added, removed };
  }

  it('returns at once on a signal that is already aborted, and listens for nothing', async () => {
    const controller = new AbortController();
    controller.abort();
    const { added } = watchListeners(controller.signal);

    await sleepUnlessStopped(60_000, controller.signal);

    expect(added).toEqual([]);
  });

  it('waits until the signal aborts, then resolves without waiting out the timer', async () => {
    const controller = new AbortController();
    let settled = false;
    const wait = sleepUnlessStopped(60_000, controller.signal).then(() => {
      settled = true;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);

    controller.abort();
    await wait;

    expect(settled).toBe(true);
  });

  it('lets go of the signal when the timer fires on its own', async () => {
    const controller = new AbortController();
    const { added, removed } = watchListeners(controller.signal);

    await sleepUnlessStopped(0, controller.signal);

    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });

  it('leaves no timer behind when cut short, so the process exits when the loop returns', async () => {
    // The property is not visible from inside the process: the loop's promise settles at the
    // same instant whether or not the poll timer is still armed. A pending timer shows only as
    // the event loop staying open, so the fixture is run as a child and its exit is watched from
    // here. The fixture stamps its own clock on both events, so the child's startup and this
    // machine's load are not in the number that is asserted on.
    const pollMs = 5_000;
    // What "at once" means here: far above the few milliseconds a drained event loop takes to
    // exit, and below any poll a worker would run with, so an armed timer fails this at the
    // default 250 ms poll too, not only at the fixture's.
    const promptExitMs = 200;
    const fixture = join(import.meta.dir, 'idle-shutdown.fixture.ts');
    const child = Bun.spawn([process.execPath, fixture, String(pollMs)], {
      stdout: 'pipe',
      stderr: 'inherit',
    });
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    const stamps = Object.fromEntries(
      [...stdout.matchAll(/^(\w+)_ms=(\d+)$/gm)].map(([, label, ms]) => [label, Number(ms)]),
    );

    expect(exitCode).toBe(0);
    expect(Object.keys(stamps).sort()).toEqual(['loop_returned', 'process_exit']);
    const loopReturnedMs = stamps.loop_returned as number;
    const processExitMs = stamps.process_exit as number;
    // The request landed inside the first idle sleep: the loop came back long before the poll
    // would have ended on its own...
    expect(loopReturnedMs).toBeLessThan(pollMs / 2);
    // ...and the process followed it out at once, rather than when that poll's timer fired.
    expect(processExitMs - loopReturnedMs).toBeLessThan(promptExitMs);
  }, 15_000);
});

describe('decideFailure', () => {
  it('follows the table in design.md "Retry, backoff, dead-letter" at the defaults', () => {
    expect(decideFailure(0, WORKER_DEFAULTS)).toEqual({
      kind: 'retry',
      attempts: 1,
      backoffMs: 1_000,
    });
    expect(decideFailure(1, WORKER_DEFAULTS)).toEqual({
      kind: 'retry',
      attempts: 2,
      backoffMs: 2_000,
    });
    expect(decideFailure(2, WORKER_DEFAULTS)).toEqual({ kind: 'dead_letter', attempts: 3 });
  });

  it('takes the ceiling and the base from the policy', () => {
    const policy = { maxAttempts: 5, backoffBaseMs: 250 };
    expect(decideFailure(3, policy)).toEqual({ kind: 'retry', attempts: 4, backoffMs: 2_000 });
    expect(decideFailure(4, policy).kind).toBe('dead_letter');
  });

  it('dead-letters on the first failure when the ceiling is one', () => {
    expect(decideFailure(0, { maxAttempts: 1, backoffBaseMs: 1_000 }).kind).toBe('dead_letter');
  });
});

describe('firstFailure', () => {
  it('takes the first failed send in target order, so last_error names one failure', () => {
    expect(
      firstFailure([
        { status: 'sent', latencyMs: 70 },
        { status: 'failed', latencyMs: 20, error: 'PushSendError: first' },
        { status: 'failed', latencyMs: 30, error: 'PushSendError: second' },
      ]),
    ).toEqual({ latencyMs: 20, error: 'PushSendError: first' });
  });

  it('refuses an attempt none of whose sends failed, which is a completion and not a retry', () => {
    expect(() => firstFailure([{ status: 'sent', latencyMs: 70 }])).toThrow('none of whose sends');
    expect(() => firstFailure([])).toThrow('none of whose sends');
  });
});

describe('describeSendFailure', () => {
  it('takes the cost from a PushSendError and names the error class', () => {
    expect(describeSendFailure(new PushSendError('simulated push failure after 80ms', 80))).toEqual(
      { latencyMs: 80, error: 'PushSendError: simulated push failure after 80ms' },
    );
  });

  it('costs zero for an error without timing, and stringifies a thrown non-error', () => {
    expect(describeSendFailure(new Error('socket closed'))).toEqual({
      latencyMs: 0,
      error: 'Error: socket closed',
    });
    expect(describeSendFailure('unplugged')).toEqual({ latencyMs: 0, error: 'unplugged' });
  });
});

describe('readWorkerConfig', () => {
  it('uses the defaults design.md names when nothing is set', () => {
    expect(readWorkerConfig({})).toEqual({
      batchSize: 25,
      pollMs: 250,
      leaseMs: 30_000,
      maxAttempts: 3,
      backoffBaseMs: 1_000,
    });
    expect(readWorkerConfig({ WORKER_BATCH_SIZE: '' })).toEqual(WORKER_DEFAULTS);
  });

  it('reads every WORKER_* variable', () => {
    expect(
      readWorkerConfig({
        WORKER_BATCH_SIZE: '50',
        WORKER_POLL_MS: '100',
        WORKER_LEASE_MS: '5000',
        WORKER_MAX_ATTEMPTS: '5',
        WORKER_BACKOFF_BASE_MS: '500',
      }),
    ).toEqual({ batchSize: 50, pollMs: 100, leaseMs: 5_000, maxAttempts: 5, backoffBaseMs: 500 });
  });

  it('refuses a value that is not a positive integer, naming the variable', () => {
    expect(() => readWorkerConfig({ WORKER_BATCH_SIZE: '0' })).toThrow(
      'WORKER_BATCH_SIZE must be a positive integer up to 2147483647, got "0"',
    );
    expect(() => readWorkerConfig({ WORKER_POLL_MS: '1.5' })).toThrow('WORKER_POLL_MS');
    expect(() => readWorkerConfig({ WORKER_LEASE_MS: '-1' })).toThrow('WORKER_LEASE_MS');
    expect(() => readWorkerConfig({ WORKER_MAX_ATTEMPTS: 'three' })).toThrow('WORKER_MAX_ATTEMPTS');
    expect(() => readWorkerConfig({ WORKER_BACKOFF_BASE_MS: '' })).not.toThrow();
  });

  it('refuses a value the claim and retry statements could not cast to a Postgres integer', () => {
    // `batchSize` and `leaseMs` reach the claim as `::int`, `attempts` is an integer column, and
    // `pollMs` becomes a setTimeout delay; one past the type's maximum would fail every claim.
    const over = String(WORKER_INT_MAX + 1);
    for (const name of [
      'WORKER_BATCH_SIZE',
      'WORKER_POLL_MS',
      'WORKER_LEASE_MS',
      'WORKER_MAX_ATTEMPTS',
      'WORKER_BACKOFF_BASE_MS',
    ]) {
      expect(() => readWorkerConfig({ [name]: over })).toThrow(
        `${name} must be a positive integer up to`,
      );
    }
    expect(readWorkerConfig({ WORKER_LEASE_MS: String(WORKER_INT_MAX) }).leaseMs).toBe(
      WORKER_INT_MAX,
    );
  });

  it('refuses a retry policy whose last backoff the retry statement could not write', () => {
    // The last retry waits base × 2^(maxAttempts − 2). A base and a ceiling that each fit can
    // still multiply past the integer the statement casts to, and a large enough ceiling makes
    // the power Infinity; both would roll back the failure record on that retry.
    expect(() =>
      readWorkerConfig({ WORKER_BACKOFF_BASE_MS: '2000000000', WORKER_MAX_ATTEMPTS: '3' }),
    ).toThrow('must stay at or below 2147483647 ms');
    expect(() =>
      readWorkerConfig({ WORKER_BACKOFF_BASE_MS: '1', WORKER_MAX_ATTEMPTS: '1100' }),
    ).toThrow('must stay at or below');
    // No retry, so no backoff to check: the base may be anything the integer holds.
    expect(() =>
      readWorkerConfig({ WORKER_BACKOFF_BASE_MS: '2000000000', WORKER_MAX_ATTEMPTS: '1' }),
    ).not.toThrow();
    expect(longestBackoffMs({ backoffBaseMs: 1_000, maxAttempts: 3 })).toBe(2_000);
    expect(longestBackoffMs({ backoffBaseMs: 1_000, maxAttempts: 1 })).toBe(0);
  });
});

describe('formatBatchLine', () => {
  it('names every count and the elapsed time', () => {
    expect(
      formatBatchLine({
        claimed: 25,
        sent: 22,
        failed: 2,
        dead: 1,
        duplicate: 0,
        skipped: 1,
        elapsedMs: 164,
      }),
    ).toBe('batch claimed=25 sent=22 failed=2 dead=1 duplicate=0 skipped=1 elapsed=0.16s');
  });
});
