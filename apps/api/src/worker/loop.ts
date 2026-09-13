// The worker loop: claim a batch, send it concurrently, record every outcome, repeat until asked
// to stop, and finish the batch in flight before stopping.
//
// design.md "The worker", "Retry, backoff, dead-letter" and "Graceful shutdown and the lease" own
// the contract. The three repository operations, the sink, the clock, the sleep and the shutdown
// signal are all injected, the shape `runTick` has, so this file is tested without Postgres, a
// timer that really waits, or the network. Keep Drizzle and Bun-only imports out of it.
//
// The one constraint carried over from the naive send: `complete` sits outside the catch that
// wraps the send. A database error while recording a send that SUCCEEDED must propagate, not land
// in the failure branch and be written down as a failed push (see `runTick`).

import { PushSendError, type PushSink } from '../push/sink';
import { REMINDER_MESSAGE } from '../scheduler/tick';

export const WORKER_ENV_NAMES = {
  batchSize: 'WORKER_BATCH_SIZE',
  pollMs: 'WORKER_POLL_MS',
  leaseMs: 'WORKER_LEASE_MS',
  maxAttempts: 'WORKER_MAX_ATTEMPTS',
  backoffBaseMs: 'WORKER_BACKOFF_BASE_MS',
} as const;

export type WorkerConfig = {
  /** Jobs one claim takes. */
  batchSize: number;
  /** How long an empty claim sleeps before the next one. */
  pollMs: number;
  /** How old a lock has to be before another worker's claim takes the row. */
  leaseMs: number;
  /** Failed sends after which a job is dead-lettered instead of retried. */
  maxAttempts: number;
  /** The first retry's delay; each later one doubles it. */
  backoffBaseMs: number;
};

/**
 * design.md "The worker" and "Retry, backoff, dead-letter" own these numbers. The lease is long
 * on purpose: a batch of 25 at 50-150 ms settles well under a second, so 30 s is room for a
 * stalled machine, and a lease shorter than a batch would hand out rows still being sent.
 */
export const WORKER_DEFAULTS: WorkerConfig = {
  batchSize: 25,
  pollMs: 250,
  leaseMs: 30_000,
  maxAttempts: 3,
  backoffBaseMs: 1_000,
};

/**
 * The largest value any of these may take: PostgreSQL's `integer`, which is what `jobs.attempts`
 * is and what the claim and retry statements cast `batchSize`, `leaseMs` and a backoff to — a
 * larger value would make every claim fail at the cast — and also the largest delay `setTimeout`
 * honours, which is what `pollMs` becomes.
 */
export const WORKER_INT_MAX = 2_147_483_647;

function readPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > WORKER_INT_MAX) {
    throw new Error(`${name} must be a positive integer up to ${WORKER_INT_MAX}, got "${raw}"`);
  }
  return value;
}

/**
 * The longest backoff the policy can ask for is the last retry's, `backoffBaseMs × 2^(maxAttempts − 2)`
 * (`decideFailure`), and the retry statement casts it to `integer`. A policy whose last backoff
 * does not fit would fail at the cast on that retry, roll back the failure's record, and leave
 * the job locked until the lease hands it on — so the policy is refused at start instead. With
 * `maxAttempts` of 1 there is no retry and nothing to check.
 */
export function longestBackoffMs(policy: RetryPolicy): number {
  if (policy.maxAttempts <= 1) return 0;
  // 2 ** n is Infinity long before any product would overflow, and Infinity fails the bound.
  return policy.backoffBaseMs * 2 ** (policy.maxAttempts - 2);
}

export function readWorkerConfig(env: Record<string, string | undefined>): WorkerConfig {
  const config = {
    batchSize: readPositiveInt(env, WORKER_ENV_NAMES.batchSize, WORKER_DEFAULTS.batchSize),
    pollMs: readPositiveInt(env, WORKER_ENV_NAMES.pollMs, WORKER_DEFAULTS.pollMs),
    leaseMs: readPositiveInt(env, WORKER_ENV_NAMES.leaseMs, WORKER_DEFAULTS.leaseMs),
    maxAttempts: readPositiveInt(env, WORKER_ENV_NAMES.maxAttempts, WORKER_DEFAULTS.maxAttempts),
    backoffBaseMs: readPositiveInt(
      env,
      WORKER_ENV_NAMES.backoffBaseMs,
      WORKER_DEFAULTS.backoffBaseMs,
    ),
  };
  const longest = longestBackoffMs(config);
  if (!Number.isFinite(longest) || longest > WORKER_INT_MAX) {
    throw new Error(
      `${WORKER_ENV_NAMES.backoffBaseMs} × 2^(${WORKER_ENV_NAMES.maxAttempts} − 2) must stay ` +
        `at or below ${WORKER_INT_MAX} ms, the longest backoff the retry statement can write; ` +
        `got ${config.backoffBaseMs} × 2^${config.maxAttempts - 2}`,
    );
  }
  return config;
}

/**
 * A job this worker holds: the row as the claim returned it, plus the token the sink is handed.
 * It carries no `attempts`: the retry decision is taken from the row under lock when the failure
 * is recorded, never from a count read at claim time (design.md "Retry, backoff, dead-letter").
 */
export type ClaimedJob = {
  id: string;
  reminderId: string;
  /** `users.expo_push_token`, which is null for every seeded user. */
  pushToken: string | null;
};

/**
 * What recording a successful send found. `reminder_not_queued` is the at-least-once case: the
 * reminder had already been moved by an earlier completion — a lease reclaim sent it twice — and
 * the `WHERE state = 'queued'` update changed nothing (design.md "Graceful shutdown and the lease").
 */
export type CompletionResult = 'recorded' | 'reminder_not_queued';

/** What a failed send cost and said: `deliveries.latency_ms`, `deliveries.error` and `jobs.last_error`. */
export type SendFailure = {
  /** From `PushSendError`, or 0 when the failure carried no timing. */
  latencyMs: number;
  error: string;
};

/**
 * What a failed send does to its job, decided by `decideFailure` from the row's live `attempts`
 * and written by the repository in the same transaction. `attempts` is the count AFTER this
 * failure; a retry's `backoffMs` is added to the database's `now()` when it is written, so every
 * `run_at` comes from one clock.
 */
export type FailureOutcome = { attempts: number } & (
  { kind: 'retry'; backoffMs: number } | { kind: 'dead_letter' }
);

/**
 * What recording a failed send did to the job. `job_done` is the at-least-once case: another
 * worker had already completed or dead-lettered it, so the `deliveries` row was written, the job
 * was left alone, and the worker counts a duplicate (design.md "Retry, backoff, dead-letter").
 */
export type FailureResult = FailureOutcome['kind'] | 'job_done';

export type RetryPolicy = Pick<WorkerConfig, 'maxAttempts' | 'backoffBaseMs'>;

/** The persistence one worker needs. Tests pass an in-memory one, `index.ts` passes Drizzle. */
export interface JobsRepository {
  /** design.md "Data model": the one claim statement, lease included, plus the claimed reminders' tokens. */
  claim(batchSize: number, workerId: string, leaseMs: number): Promise<ClaimedJob[]>;
  /** One `deliveries` row, the job's `done_at`, the reminder `queued -> sent`, in one transaction. */
  complete(job: ClaimedJob, latencyMs: number): Promise<CompletionResult>;
  /**
   * One `deliveries` row with the failure, then the job's `attempts` re-read under `FOR UPDATE`
   * and `decideFailure` over it: either the retry (`attempts`, `last_error`,
   * `run_at = now() + backoff`, `locked_at = NULL`) or the dead-letter (`attempts`, `last_error`,
   * `dead_at`, `done_at`, the reminder `queued -> failed`), in one transaction. Returns which.
   */
  retryOrDeadLetter(
    job: ClaimedJob,
    failure: SendFailure,
    policy: RetryPolicy,
  ): Promise<FailureResult>;
}

export function describeSendFailure(error: unknown): SendFailure {
  const latencyMs = error instanceof PushSendError ? error.latencyMs : 0;
  if (error instanceof Error) return { latencyMs, error: `${error.name}: ${error.message}` };
  return { latencyMs, error: String(error) };
}

/**
 * design.md "Retry, backoff, dead-letter", as arithmetic over `attemptsBefore`, the row's count
 * as it stands when the failure is recorded: increment first, then compare the incremented count
 * to the ceiling, and take the backoff's exponent from the incremented count. At the defaults:
 * 1 s after the first failure, 2 s after the second, dead-lettered on the third.
 */
export function decideFailure(attemptsBefore: number, policy: RetryPolicy): FailureOutcome {
  const attempts = attemptsBefore + 1;
  if (attempts < policy.maxAttempts) {
    return { kind: 'retry', attempts, backoffMs: policy.backoffBaseMs * 2 ** (attempts - 1) };
  }
  return { kind: 'dead_letter', attempts };
}

/**
 * One batch's counts. `sent`, `duplicate` and `failed` partition the outcomes that were recorded;
 * `dead` is the part of `failed` that was dead-lettered.
 */
export type BatchResult = {
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  duplicate: number;
  elapsedMs: number;
};

export type WorkerSummary = {
  batches: number;
  claimed: number;
  sent: number;
  failed: number;
  dead: number;
  duplicate: number;
  /** The size of the batch that was in flight when shutdown was requested, or 0 if none was. */
  drained: number;
};

export type WorkerLoopDeps = {
  jobs: JobsRepository;
  sink: PushSink;
  /** `hostname:pid` in the process; whatever a test likes. Written to `jobs.locked_by`. */
  workerId: string;
  config: WorkerConfig;
  /** Milliseconds on a monotonic clock, for the per-batch elapsed figure. */
  clock: () => number;
  /**
   * The idle wait after an empty claim, handed the shutdown signal: it resolves after `ms` or as
   * soon as the signal aborts, and releases whatever timer it armed when it is cut short.
   * `sleepUnlessStopped` is the process's; a test's is whatever resolves when the test says so.
   */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Aborted when shutdown is requested: no further claim, and the batch in flight is finished. */
  shutdown: AbortSignal;
  log: (line: string) => void;
};

/**
 * `duplicate` is a send recorded after another worker had finished the job, whether this send
 * succeeded or failed; `failed` a failed send that was retried, `dead` one that was dead-lettered.
 */
type AttemptOutcome = 'sent' | 'duplicate' | 'failed' | 'dead';

/**
 * The process's idle wait: a timer for `ms`, cut short by the shutdown signal, and cleared when it
 * is. Cutting the wait short is not enough on its own. Racing a sleep that cannot be cancelled
 * against the signal returns just as promptly but leaves its timer armed, and a pending timer
 * holds the event loop open, so the process would print its shutdown line, close its database
 * client, and then sit for the rest of `pollMs` before exiting (design.md "Graceful shutdown and
 * the lease").
 *
 * The abort listener is added for this one wait and removed when the wait ends, whichever way it
 * ends. One long-lived "aborted" promise raced against every poll would attach a reaction per poll
 * and release none of them until shutdown, and idle is this worker's usual state: the peak is one
 * minute a day.
 */
export function sleepUnlessStopped(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** The two signals a shutdown request arrives on. */
export const SHUTDOWN_SIGNALS = ['SIGTERM', 'SIGINT'] as const;
export type ShutdownSignal = (typeof SHUTDOWN_SIGNALS)[number];

/** The part of `process` the handlers need, so a test can hand in an emitter of its own. */
export type SignalTarget = {
  once(signal: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
  off(signal: ShutdownSignal, listener: (signal: ShutdownSignal) => void): unknown;
};

/**
 * Request shutdown on the first `SIGTERM` or `SIGINT`, and let the second signal of either kind
 * kill the process.
 *
 * One listener serves both signals, and the first signal removes it from both before requesting
 * shutdown. A `once` listener per signal would not do: after `SIGTERM` the `SIGINT` listener is
 * still installed, so an operator who follows up with Ctrl-C to abandon a stuck batch would run
 * the graceful path a second time instead of reaching the runtime's default, which the log line
 * printed at the first signal promises (design.md "Graceful shutdown and the lease").
 */
export function installShutdownHandlers(
  target: SignalTarget,
  requestShutdown: () => void,
  log: (line: string) => void,
): void {
  const onSignal = (signal: ShutdownSignal) => {
    for (const other of SHUTDOWN_SIGNALS) target.off(other, onSignal);
    log(`${signal}: no more claims, finishing the batch in flight (a second signal kills)`);
    requestShutdown();
  };
  for (const signal of SHUTDOWN_SIGNALS) target.once(signal, onSignal);
}

/** One line per batch; the process prefixes the timestamp. */
export function formatBatchLine(result: BatchResult): string {
  const { claimed, sent, failed, dead, duplicate, elapsedMs } = result;
  return (
    `batch claimed=${claimed} sent=${sent} failed=${failed} dead=${dead} duplicate=${duplicate} ` +
    `elapsed=${(elapsedMs / 1000).toFixed(2)}s`
  );
}

/** The one line at shutdown: what was drained, and the totals since start. */
export function formatShutdownLine(summary: WorkerSummary): string {
  const { drained, batches, claimed, sent, failed, dead, duplicate } = summary;
  const inFlight = drained === 0 ? 'nothing in flight' : `drained ${drained} in flight`;
  return (
    `stopped: ${inFlight}; batches=${batches} claimed=${claimed} sent=${sent} failed=${failed} ` +
    `dead=${dead} duplicate=${duplicate}`
  );
}

/**
 * Run until shutdown is requested, then return once the batch in flight has settled.
 *
 * Each claimed job is sent through the sink at once — every send is started before any is
 * awaited — and each outcome is recorded in its own transaction as it arrives. An empty claim
 * sleeps `pollMs`; the sleep is handed the shutdown signal, so a request cuts it short and
 * leaves no timer behind to hold the process open.
 *
 * A recording error (the database, not the sink) is fatal: the rest of the batch is allowed to
 * settle first, then the error propagates and the process exits non-zero. The jobs it could not
 * record stay locked in this worker's name and the lease hands them to another worker, which
 * at-least-once already permits (design.md "Graceful shutdown and the lease").
 */
export async function runWorkerLoop({
  jobs,
  sink,
  workerId,
  config,
  clock,
  sleep,
  shutdown,
  log,
}: WorkerLoopDeps): Promise<WorkerSummary> {
  const summary: WorkerSummary = {
    batches: 0,
    claimed: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    duplicate: 0,
    drained: 0,
  };
  const attempt = async (job: ClaimedJob): Promise<AttemptOutcome> => {
    let latencyMs: number;
    try {
      ({ latencyMs } = await sink.send(job.pushToken, REMINDER_MESSAGE));
    } catch (error) {
      // The repository decides retry or dead-letter from the row it locks, so what it did is
      // read back from it rather than predicted here.
      const written = await jobs.retryOrDeadLetter(job, describeSendFailure(error), config);
      if (written === 'job_done') return 'duplicate';
      return written === 'dead_letter' ? 'dead' : 'failed';
    }
    const result = await jobs.complete(job, latencyMs);
    return result === 'recorded' ? 'sent' : 'duplicate';
  };

  while (!shutdown.aborted) {
    const startedAt = clock();
    const batch = await jobs.claim(config.batchSize, workerId, config.leaseMs);
    if (batch.length === 0) {
      await sleep(config.pollMs, shutdown);
      continue;
    }

    const settled = await Promise.allSettled(batch.map((job) => attempt(job)));
    const result: BatchResult = {
      claimed: batch.length,
      sent: 0,
      failed: 0,
      dead: 0,
      duplicate: 0,
      elapsedMs: clock() - startedAt,
    };
    for (const outcome of settled) {
      if (outcome.status !== 'fulfilled') continue;
      if (outcome.value === 'sent') result.sent += 1;
      else if (outcome.value === 'duplicate') result.duplicate += 1;
      else {
        result.failed += 1;
        if (outcome.value === 'dead') result.dead += 1;
      }
    }

    summary.batches += 1;
    summary.claimed += result.claimed;
    summary.sent += result.sent;
    summary.failed += result.failed;
    summary.dead += result.dead;
    summary.duplicate += result.duplicate;
    // The loop checked the signal before this claim, so an aborted signal here means the request
    // arrived while this batch was in flight, and this batch is what was drained.
    if (shutdown.aborted) summary.drained = batch.length;
    log(formatBatchLine(result));

    const failure = settled.find((outcome) => outcome.status === 'rejected');
    if (failure) throw failure.reason;
  }

  return summary;
}
