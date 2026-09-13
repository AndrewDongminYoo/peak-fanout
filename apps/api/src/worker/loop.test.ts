import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import { PushSendError, type PushMessage, type PushSink } from '../push/sink';
import { REMINDER_MESSAGE } from '../scheduler/tick';
import {
  decideFailure,
  describeSendFailure,
  formatBatchLine,
  formatShutdownLine,
  readWorkerConfig,
  runWorkerLoop,
  sleepUnlessStopped,
  WORKER_DEFAULTS,
  type JobsRepository,
  type RetryPolicy,
  type SendFailure,
  type WorkerLoopDeps,
} from './loop';

/** The database's `now()` for every fake statement below: one instant, so arithmetic is exact. */
const NOW = new Date('2026-09-15T12:00:00.000Z');

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

type SeedJob = { id: string; reminderId: string; attempts?: number; pushToken?: string | null };

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
  const pushTokens = new Map<string, string | null>();
  for (const job of seed) {
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
    pushTokens.set(job.reminderId, job.pushToken ?? null);
  }
  const deliveries: DeliveryRow[] = [];
  const calls = {
    claim: [] as Array<{ batchSize: number; workerId: string; leaseMs: number }>,
    complete: [] as string[],
    retryOrDeadLetter: [] as Array<{ failure: SendFailure; policy: RetryPolicy }>,
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
        pushToken: pushTokens.get(row.reminderId) ?? null,
      }));
    },
    async complete(job, latencyMs) {
      calls.complete.push(job.id);
      deliveries.push({ reminderId: job.reminderId, status: 'sent', latencyMs, error: null });
      const moved = reminderRows.get(job.reminderId) === 'queued';
      if (moved) reminderRows.set(job.reminderId, 'sent');
      const row = jobRows.get(job.id);
      if (row && row.doneAt === null) row.doneAt = NOW;
      return moved ? 'recorded' : 'reminder_not_queued';
    },
    async retryOrDeadLetter(job, failure, policy) {
      calls.retryOrDeadLetter.push({ failure, policy });
      deliveries.push({
        reminderId: job.reminderId,
        status: 'failed',
        latencyMs: failure.latencyMs,
        error: failure.error,
      });
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

const job = (id: string, attempts = 0, pushToken: string | null = null): SeedJob => ({
  id,
  reminderId: `r-${id}`,
  attempts,
  pushToken,
});

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
      'batch claimed=3 sent=3 failed=0 dead=0 duplicate=0 elapsed=0.00s',
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

  it('hands the sink the reminder’s token as stored and the shared reminder copy', async () => {
    const queue = createMemoryJobs([job('a', 0, 'ExponentPushToken[abc]'), job('b')]);
    const { sink, calls } = fakeSink(() => 60);

    await runWorkerLoop(deps(queue.repository, sink).deps);

    // Sends start in claim order, synchronously, so the call order is the batch order.
    expect(calls.map((call) => call.token)).toEqual(['ExponentPushToken[abc]', null]);
    expect(calls.every((call) => call.message === REMINDER_MESSAGE)).toBe(true);
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
        failure: { latencyMs: 90, error: 'PushSendError: simulated push failure after 90ms' },
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
    expect(wired.lines[0]).toBe('batch claimed=1 sent=0 failed=1 dead=0 duplicate=0 elapsed=0.00s');
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
    expect(wired.lines[0]).toBe('batch claimed=1 sent=0 failed=1 dead=1 duplicate=0 elapsed=0.00s');
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
    expect(wired.lines[0]).toBe('batch claimed=1 sent=0 failed=0 dead=0 duplicate=1 elapsed=0.00s');
  });

  it('dead-letters the attempt that reaches the ceiling and fails the reminder', async () => {
    const queue = createMemoryJobs([job('a', 2)]);
    const { sink } = fakeSink(() => new PushSendError('still no', 120));
    const wired = deps(queue.repository, sink);

    const summary = await runWorkerLoop(wired.deps);

    expect(queue.calls.retryOrDeadLetter).toEqual([
      { failure: { latencyMs: 120, error: 'PushSendError: still no' }, policy: WORKER_DEFAULTS },
    ]);
    expect(queue.jobRows.get('a')).toMatchObject({
      attempts: 3,
      deadAt: NOW,
      doneAt: NOW,
      lastError: 'PushSendError: still no',
    });
    expect(queue.reminderRows.get('r-a')).toBe('failed');
    expect(summary).toMatchObject({ claimed: 1, sent: 0, failed: 1, dead: 1 });
    expect(wired.lines[0]).toBe('batch claimed=1 sent=0 failed=1 dead=1 duplicate=0 elapsed=0.00s');
    // Dead-lettered means done: the next claim does not hand it out again.
    expect(queue.calls.claim.length).toBe(2);
    expect(queue.calls.retryOrDeadLetter.length).toBe(1);
  });

  it('records a failure that carries no timing as costing zero, as the naive send does', async () => {
    const queue = createMemoryJobs([job('a')]);
    const { sink } = fakeSink(() => new Error('socket closed'));

    await runWorkerLoop(deps(queue.repository, sink).deps);

    expect(queue.calls.retryOrDeadLetter[0]?.failure).toEqual({
      latencyMs: 0,
      error: 'Error: socket closed',
    });
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
      'stopped: drained 3 in flight; batches=1 claimed=3 sent=3 failed=0 dead=0 duplicate=0',
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
      'stopped: nothing in flight; batches=1 claimed=1 sent=1 failed=0 dead=0 duplicate=0',
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
    expect(wired.lines[0]).toBe('batch claimed=2 sent=1 failed=0 dead=0 duplicate=1 elapsed=0.00s');
  });

  it('lets a recording error through only after the rest of the batch has settled', async () => {
    // Recording, not sending, failed: the send SUCCEEDED, so this must not become a failed
    // attempt (the `runTick` lesson), and the sibling still in flight must be recorded before
    // the error escapes, or a shutdown that raced it would leave a send nobody wrote down.
    const queue = createMemoryJobs([job('a'), job('b')]);
    const completeGates: Array<() => void> = [];
    const repository: JobsRepository = {
      ...queue.repository,
      async complete(jobToRecord, latencyMs) {
        if (jobToRecord.id === 'a') throw new Error('write CONFLICT: connection terminated');
        await new Promise<void>((resolve) => completeGates.push(resolve));
        return queue.repository.complete(jobToRecord, latencyMs);
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
    expect(wired.lines[0]).toBe('batch claimed=2 sent=1 failed=0 dead=0 duplicate=0 elapsed=0.00s');
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
      'WORKER_BATCH_SIZE must be a positive integer, got "0"',
    );
    expect(() => readWorkerConfig({ WORKER_POLL_MS: '1.5' })).toThrow('WORKER_POLL_MS');
    expect(() => readWorkerConfig({ WORKER_LEASE_MS: '-1' })).toThrow('WORKER_LEASE_MS');
    expect(() => readWorkerConfig({ WORKER_MAX_ATTEMPTS: 'three' })).toThrow('WORKER_MAX_ATTEMPTS');
    expect(() => readWorkerConfig({ WORKER_BACKOFF_BASE_MS: '' })).not.toThrow();
  });
});

describe('formatBatchLine', () => {
  it('names every count and the elapsed time', () => {
    expect(
      formatBatchLine({ claimed: 25, sent: 23, failed: 2, dead: 1, duplicate: 0, elapsedMs: 164 }),
    ).toBe('batch claimed=25 sent=23 failed=2 dead=1 duplicate=0 elapsed=0.16s');
  });
});
