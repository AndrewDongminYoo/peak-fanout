// The run log: one JSON file per measured run, and the only thing a README measurement cell may
// be copied from (AGENTS.md gate rule 4).
//
// `buildRunLog` refuses to produce an object with a missing metric, so a metric the harness
// forgot to collect fails here instead of writing `null` into a cell that a reader would then
// read as a measurement.

import {
  type CounterSample,
  type LatencySummary,
  durationMs,
  transactionsPerSecond,
} from './metrics';
import { CARDS_CACHE_DEFAULTS } from '../cards/cache';
import { describeSender, type DeliverySender } from '../push/sender';
import { SIMULATED_SINK_DEFAULTS } from '../push/simulated';

// 2 renamed the provenance field. A run is performed before the commit that carries its log —
// that is what "the measured run and its `load/results/*.json` in the same pull request" means —
// so a field called `git_commit` would name a tree that cannot contain the code that produced the
// run. Version 2 records `base_commit` plus `worktree_dirty` instead, which is what is true.
//
// 3 replaced the sink block. Version 2 wrote the three `PUSH_SIM_*` values as the harness process
// read them, which is not the process that sends: a scheduler started with other values inflated
// the fan-out while the log still read the harness's. Version 3 states the sink module's pinned
// constants and the per-send cost measured from the `deliveries` rows the sender wrote, and grades
// one against the other (design.md "The push sink").
//
// 4 grades the observed bounds as well as the observed mean. Version 3 graded the mean alone and
// recorded the bounds for the reader, which let a sender started with any distribution sharing
// the pinned midpoint — 0..200 as readily as 50..150 — pass every check and be committed as
// comparable. The verdict now carries a sixth check on where the smallest and largest send cost
// landed, which is what makes a symmetric change to the bounds a missed verdict.
//
// 5 grades the sender's own record of its settings (#25). No tolerance on measured extrema can
// tell 51..149 from 50..150 — the minimum's tolerance has to admit the timer's overshoot, and any
// tolerance that large admits a sender shifted by less than it — so every sender now writes the
// settings it read into `deliveries.sender`, and an eighth check grades the distinct records over
// the window's peak deliveries against exactly one record built from the sink module's constants.
//
// 5 also grades the offered rate (#26). The generator skips a beat under backpressure and its
// interval timer fires late on a loaded machine without replaying the beat it missed; version 4
// recorded the in-window count and the skip counter and graded neither, so a run under less
// traffic than its setting passed and was compared against one under more. A seventh check holds
// `requests_in_window` to 95% of the target rate over the observed window.
//
// 5 is also the first schema a queue run writes. The log records `mode`; the terminal-state check
// counts `queued` beside `pending`, because a reminder handed to the queue is not delivered; the
// attempts check is per mode, exact for the naive sender and at-least-once for the queue, with
// the duplicate count recorded beside it; and a `queue` block records the workers and the largest
// claim as the run observed them, never as anything the harness was told.
//
// 5 adds the `restart` block a restart run writes and the ninth check it is graded on: what became
// of the jobs the killed worker held, and that none was lost. Its file name says which run it is.
//
// 6 records the exact variant, makes the topology note variant-aware (#29), extends a worker's
// sender record with its cards cache and read database, and records the replica's transaction
// samples beside the primary's for the two M3 replica variants.
export const RUN_LOG_SCHEMA_VERSION = 6;

/**
 * What the harness measures: the M1 sender (the scheduler under `SCHEDULER_MODE=naive`) or the
 * M2 queue (the enqueue tick plus N workers). design.md "Metric definitions and their sources".
 */
export const LOAD_MODES = ['naive', 'queue'] as const;
export type LoadMode = (typeof LOAD_MODES)[number];

export const LOAD_VARIANTS = [
  'm1-naive',
  'm2-queue',
  'm3-primary-cache-off',
  'm3-replica-cache-off',
  'm3-replica-cache-on',
] as const;
export type LoadVariant = (typeof LOAD_VARIANTS)[number];

export function variantMode(variant: LoadVariant): LoadMode {
  return variant === 'm1-naive' ? 'naive' : 'queue';
}

export function variantUsesReplica(variant: LoadVariant): boolean {
  return variant === 'm3-replica-cache-off' || variant === 'm3-replica-cache-on';
}

function variantCacheEnabled(variant: LoadVariant): boolean {
  return variant !== 'm3-primary-cache-off' && variant !== 'm3-replica-cache-off';
}

export function runLogMilestone(variant: LoadVariant): string {
  if (variant === 'm1-naive') return 'M1 naive';
  if (variant === 'm2-queue') return 'M2 queue';
  return 'M3 cache + read replica';
}

export function runLogNote(variant: LoadVariant): string {
  const sender =
    variantMode(variant) === 'naive'
      ? 'the naive scheduler'
      : 'the enqueue scheduler and the workers';
  return (
    `Single-machine localhost run: Postgres in docker compose, the API, ${sender} and the load ` +
    'generator all on one Mac, against the simulated push sink. Not a deployment measurement.'
  );
}

export type VerdictCheck = {
  name: string;
  target: string;
  actual: string;
  met: boolean;
};

export type RunLogInput = {
  mode: LoadMode;
  variant: LoadVariant;
  /** `git rev-parse HEAD` when the run started: the tree the run was performed on top of. */
  baseCommit: string;
  /** Whether that tree had uncommitted changes, which for a run in its own pull request it has. */
  worktreeDirty: boolean;
  startedAt: Date;
  endedAt: Date;
  seed: {
    targetDate: string;
    peakInstant: Date;
    /** The rows `load/verify-peak.sql` returned, keyed by their `key` column. */
    verified: Record<string, string>;
    prePeakMarkedSent: number;
  };
  /**
   * What one send actually cost, over the target instant's `deliveries` rows: the sink measured
   * each latency and the sender wrote it down.
   *
   * The pinned parameters are deliberately NOT an input. They are the sink module's constants, so
   * no caller can put its own `PUSH_SIM_*` environment where a measurement belongs — which is the
   * mistake version 2 made (design.md "The push sink"). The expected sender record is built from
   * the same constants, for the same reason.
   */
  sink: {
    observedMinLatencyMs: number;
    observedMaxLatencyMs: number;
    observedMeanLatencyMs: number;
  };
  fanout: {
    /** Reminders sitting on the target instant, which is what the run set out to send. */
    reminders: number;
    attempts: number;
    sent: number;
    failed: number;
    pendingAfter: number;
    /** Reminders still `queued` at window close: handed to the queue and never finished. */
    queuedAfter: number;
    firstSendStartedAt: Date;
    lastSendFinishedAt: Date;
    /**
     * The distinct `deliveries.sender` records over the window's peak deliveries, as the sender
     * wrote them and the database read them back, in a stable order; and how many of those rows
     * carry no record at all. The two together are the set the eighth check grades.
     */
    senderRecordsObserved: unknown[];
    sendsWithoutSenderRecord: number;
  };
  /** Queue mode only: what the run observed of the fleet, never what it was told. */
  queue?: {
    /** The distinct `jobs.locked_by` ids over the peak's jobs at window close. */
    workers: string[];
    /** The most jobs sharing one `(locked_by, locked_at)` pair: one claim statement's batch. */
    largestClaimObserved: number;
    /** `count(*) - count(DISTINCT reminder_id)` over the window's peak deliveries. */
    duplicateAttempts: number;
  };
  /** A restart run only: the kill, and what became of the jobs the killed worker held. */
  restart?: {
    /** `hostname:pid` as the worker wrote it to `locked_by`. */
    killedWorker: string;
    /** The harness's clock when the signal was sent. */
    killedAt: Date;
    attemptsAtKill: number;
    jobsHeldAtKill: number;
    /** Held jobs the killed worker itself recorded between the pick and the kill. */
    finishedByKilledWorker: number;
    /** Held jobs re-stamped by the lease reclaim and finished by another worker: delayed, not lost. */
    finishedByAnotherWorker: number;
    /** Held jobs with `done_at` still null at window close. */
    stillOpenAtClose: number;
    /** The earliest re-stamp of a held job by another worker; absent when none was reclaimed. */
    firstReclaimAt?: Date;
  };
  api: {
    url: string;
    poolUsers: number;
    requestsPerSecond: number;
    requestsTotal: number;
    /** Requests the generator did not send because too many were already in flight. */
    requestsSkipped: number;
    /**
     * The fan-out window as the harness observed it, which is what the samples below are sliced
     * to: the request timestamps are the harness's clock and the `deliveries` timestamps in
     * `fanout` are the database's (design.md "Metric definitions and their sources").
     */
    windowStartedAt: Date;
    windowEndedAt: Date;
    window: LatencySummary;
  };
  database: {
    before: CounterSample;
    after: CounterSample;
    peakConnections: number;
    maxConnections: number;
  };
  /** M3 replica variants only: the same two counter samples, read through DATABASE_READ_URL. */
  replica?: {
    /** Credential-free endpoint identity the worker records before sending. */
    endpoint: string;
    before: CounterSample;
    after: CounterSample;
  };
};

export type RunLog = ReturnType<typeof buildRunLog>;

/** What a send costs on average by design: the midpoint of the pinned uniform distribution. */
const PINNED_MEAN_LATENCY_MS =
  (SIMULATED_SINK_DEFAULTS.minLatencyMs + SIMULATED_SINK_DEFAULTS.maxLatencyMs) / 2;

/**
 * How far the measured mean send cost may sit from the pinned mean.
 *
 * Wide enough that a run never misses on its own draws and narrow enough to catch a changed
 * distribution in either direction; design.md "Metric definitions and their sources" derives the
 * figure from the distribution's standard error over the peak's 8,000 sends, and states the probe
 * that shows a worker's concurrent sends stay inside it too, so it is one figure for both modes.
 */
export const SINK_MEAN_TOLERANCE_MS = 5;

/**
 * How far above the pinned minimum the smallest measured send cost may sit.
 *
 * The sink measures elapsed time and a timer never fires early, so the smallest cost is never
 * below the pinned minimum; over 8,000 uniform draws the smallest lands within a hundredth of a
 * millisecond of it, and timer overhead adds well under a millisecond. Two milliseconds is
 * therefore room for the machine and none for a different distribution: a sender whose minimum
 * is 0 or 60 misses this by a wide margin either way.
 *
 * The largest cost is graded on one side only — it must reach the pinned maximum — because timer
 * overshoot pushes it above the bound by an amount that depends on machine load, and a narrower
 * distribution is caught by failing to reach it rather than by exceeding it.
 *
 * What this tolerance cannot do is tell 51..149 from 50..150, and that is not a bad constant: it
 * has to admit the overshoot, and anything that admits the overshoot admits a shift smaller than
 * it. The sender record check closes that (design.md "The push sink").
 */
export const SINK_MIN_TOLERANCE_MS = 2;

/**
 * How far short of its target rate the generator may fall over the observed window, in percent.
 *
 * The M1 baseline fell 3% short at a load average near 15; on a quiet machine the timer's lag is
 * smaller. The generator starts before the window opens, so there is no ramp inside it, and the
 * window's bounds are poll instants against a 50 ms request interval, so the boundary error is at
 * most one request each side. Five percent is one form for every window length; design.md "Metric
 * definitions and their sources", "Offered rate", writes the arithmetic for both windows — the
 * 2026-09-12 schema-4 M1 log the figure was calibrated on and a 15–20 s M2 window.
 */
export const OFFERED_RATE_TOLERANCE_PERCENT = 5;

/**
 * The record every peak delivery of a run in `variant` is expected to carry: pinned sink and
 * cache constants under the declared sender and read route. Nothing comes from the harness's
 * cache environment, because the worker is the process that reads those settings.
 */
export function expectedSender(variant: LoadVariant, replicaEndpoint?: string): DeliverySender {
  if (variantMode(variant) === 'naive') {
    return describeSender('naive', SIMULATED_SINK_DEFAULTS);
  }
  return describeSender('worker', SIMULATED_SINK_DEFAULTS, {
    cache: { ...CARDS_CACHE_DEFAULTS, enabled: variantCacheEnabled(variant) },
    readDatabase: variantUsesReplica(variant) ? 'replica' : 'primary',
    ...(variantUsesReplica(variant) ? { readEndpoint: replicaEndpoint } : {}),
  });
}

/**
 * A value as text with object keys in one order, so two records are compared by what they hold.
 *
 * The observed records are read back from `jsonb`, which orders keys its own way (by length,
 * then byte by byte), while the expected one is a TypeScript literal; `JSON.stringify` on each would
 * disagree on identical records. Arrays keep their order, because in one an order means something.
 */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Whether the generator offered its rate: `requests_in_window` against the target rate over the
 * observed window, in integer arithmetic so the check at exactly the tolerance does not turn on
 * a floating-point rounding. The window is the harness's clock (`api.windowStartedAt` to
 * `api.windowEndedAt`), never the fan-out timestamps, which are the database's.
 */
export function offeredRateHolds(
  requestsInWindow: number,
  requestsPerSecond: number,
  windowMs: number,
): boolean {
  // requestsInWindow >= (1 - tolerance) × rps × windowMs / 1000, cleared of the division.
  return (
    requestsInWindow * 100 * 1000 >=
    (100 - OFFERED_RATE_TOLERANCE_PERCENT) * requestsPerSecond * windowMs
  );
}

/**
 * The checks a run is graded against; there is no target on the fan-out duration, by design.
 *
 * Each of these has to be reachable in a log the harness actually writes, or the verdict is
 * decoration. The two send-cost checks and the sender check are reachable by a run that completes
 * normally, with a sender that was given other `PUSH_SIM_*` values — the one case a fully
 * delivered fan-out still has to read as a different experiment — and the sender check also by
 * the wrong `SCHEDULER_MODE`, whose records name the sender the mode does not measure. The
 * offered-rate check is reachable by a run on a loaded machine. The two that grade the fan-out
 * are reachable through the stall path: when the fan-out stops making progress the harness gives
 * up, writes the log anyway with the reminders that never left `pending` or `queued`, and exits
 * non-zero (`m1.ts`, `waitForFanoutEnd`). The restart check is reachable by a window that closes
 * on jobs still locked — a fleet whose `WORKER_LEASE_MS`, read in its own processes, outlasts the
 * harness's stall timeout, or one whose remaining workers die with the killed one.
 *
 * What is NOT graded here is refused upstream instead, before a log exists: nothing delivered at
 * all (`waitForFanoutStart`), and no request inside the window (`m1.ts` refuses rather than
 * summarizing an empty sample, since a p95 over nothing is not a measurement). Those are
 * preconditions of a measured run, not results of one, so the API check asks only about errors
 * and reports the in-window count beside them.
 */
export function evaluateVerdict(input: RunLogInput): VerdictCheck[] {
  const { mode, variant, fanout, api, sink, queue, restart, replica } = input;
  const attemptsCheck: VerdictCheck =
    mode === 'naive'
      ? {
          name: 'one delivery attempt recorded per peak reminder',
          target: `${fanout.reminders} attempts`,
          actual: `${fanout.attempts} attempts`,
          met: fanout.attempts === fanout.reminders,
        }
      : {
          // At-least-once: a lease reclaim may send a reminder twice, and both rows are true
          // (design.md "Graceful shutdown and the lease"). The duplicate count says how far above.
          name: 'at least one delivery attempt recorded per peak reminder',
          target: `at least ${fanout.reminders} attempts`,
          actual: `${fanout.attempts} attempts, ${queue?.duplicateAttempts ?? 0} of them duplicates`,
          met: fanout.attempts >= fanout.reminders,
        };

  const windowMs = durationMs(api.windowStartedAt, api.windowEndedAt);
  const expectedRequests = (api.requestsPerSecond * windowMs) / 1000;
  const expected = expectedSender(variant, replica?.endpoint);
  const expectedText = stableJson(expected);
  const observedTexts = fanout.senderRecordsObserved.map(stableJson);

  const checks: VerdictCheck[] = [
    {
      name: 'every reminder on the peak instant reached a terminal state',
      target: '0 still pending or queued',
      actual: `${fanout.pendingAfter} still pending, ${fanout.queuedAfter} still queued`,
      met: fanout.pendingAfter === 0 && fanout.queuedAfter === 0,
    },
    attemptsCheck,
    {
      name: 'the API answered every request during the fan-out window',
      target: '0 errors',
      actual: `${api.window.errors} errors in ${api.window.count} in-window requests`,
      met: api.window.errors === 0,
    },
    {
      // The two checks below are what makes a changed sink visible in a run that otherwise
      // completed: the sends happen in another process, so this is a measurement of that
      // process's sink and not a copy of anything the harness was configured with.
      name: 'the fan-out paid the pinned simulated sink mean per send',
      target: `${PINNED_MEAN_LATENCY_MS} ms mean, within ${SINK_MEAN_TOLERANCE_MS} ms`,
      actual: `${sink.observedMeanLatencyMs} ms mean over ${fanout.attempts} attempts`,
      met: Math.abs(sink.observedMeanLatencyMs - PINNED_MEAN_LATENCY_MS) <= SINK_MEAN_TOLERANCE_MS,
    },
    {
      // The mean alone cannot tell 50..150 from 0..200, whose midpoints coincide. Where the
      // smallest and largest send costs landed can: see SINK_MIN_TOLERANCE_MS for why the
      // minimum is graded tightly and the maximum on one side only.
      name: 'the fan-out drew its send costs from the pinned bounds',
      target:
        `smallest send within ${SINK_MIN_TOLERANCE_MS} ms above ${SIMULATED_SINK_DEFAULTS.minLatencyMs} ms, ` +
        `largest send at or above ${SIMULATED_SINK_DEFAULTS.maxLatencyMs} ms`,
      actual: `${sink.observedMinLatencyMs}..${sink.observedMaxLatencyMs} ms observed`,
      met:
        sink.observedMinLatencyMs >= SIMULATED_SINK_DEFAULTS.minLatencyMs &&
        sink.observedMinLatencyMs <= SIMULATED_SINK_DEFAULTS.minLatencyMs + SINK_MIN_TOLERANCE_MS &&
        sink.observedMaxLatencyMs >= SIMULATED_SINK_DEFAULTS.maxLatencyMs,
    },
    {
      // The pinned failure rate is 0, so a single failed send says the sender's sink was not the
      // pinned one. A pinned rate above 0 would need a proportion test rather than this equality,
      // and would be a different experiment anyway. A killed worker's send that was never
      // recorded is not a failed send, so a restart run holds this too.
      name: 'no send failed, as the pinned failure rate of 0 requires',
      target: '0 failed',
      actual: `${fanout.failed} failed of ${fanout.attempts} attempts`,
      met: fanout.failed === 0,
    },
    {
      // The count and not the skip counter: the count is what the API received, and it covers
      // both a backed-off generator and a timer that fired late (design.md "Offered rate").
      name: 'the load generator offered its target rate over the observed window',
      target:
        `at least ${100 - OFFERED_RATE_TOLERANCE_PERCENT}% of ${api.requestsPerSecond}/s over ` +
        `${windowMs / 1000} s (${Math.round(expectedRequests * 100) / 100} requests)`,
      actual: `${api.window.count} requests in window`,
      met: offeredRateHolds(api.window.count, api.requestsPerSecond, windowMs),
    },
    {
      // Graded beside the measured costs, not instead of them: a modified sink module at its
      // defaults writes a record that matches and is caught only by the measurement; a shifted
      // PUSH_SIM_* environment pays a cost the tolerances admit and is caught only here.
      name: 'every peak delivery carries the one pinned sender record',
      target: `one record: ${expectedText}`,
      actual:
        `${observedTexts.length} distinct record${observedTexts.length === 1 ? '' : 's'}, ` +
        `${fanout.sendsWithoutSenderRecord} sends without one` +
        (observedTexts.length > 0 ? `: ${observedTexts.join(' | ')}` : ''),
      met:
        fanout.sendsWithoutSenderRecord === 0 &&
        observedTexts.length === 1 &&
        observedTexts[0] === expectedText,
    },
  ];

  if (restart) {
    // The union of the two sets design.md defines is the first count: a peak job open at close
    // is a reminder still `queued`, because a job is finished in the transaction that moves its
    // reminder. The killed worker's share is reported beside it, not added to it.
    const lost = fanout.pendingAfter + fanout.queuedAfter;
    checks.push({
      name: 'no job was lost across the worker restart',
      target: '0 lost',
      actual:
        `${lost} lost: ${lost} peak reminders not terminal at close; of the ${restart.jobsHeldAtKill} ` +
        `jobs the killed worker held, ${restart.stillOpenAtClose} still open, ` +
        `${restart.finishedByAnotherWorker} reclaimed and finished by another worker, ` +
        `${restart.finishedByKilledWorker} finished by the killed worker before the kill`,
      met: lost === 0,
    });
  }
  return checks;
}

/** Paths of every leaf that is missing, null, or not a number when a number was expected. */
function missingFields(value: unknown, path = ''): string[] {
  if (value === undefined || value === null) return [path || '(root)'];
  if (typeof value === 'number' && !Number.isFinite(value)) return [path || '(root)'];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => missingFields(item, `${path}[${index}]`));
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
      missingFields(item, path ? `${path}.${key}` : key),
    );
  }
  return [];
}

/**
 * The optional blocks are omitted when absent and never written as `null`: `missingFields`
 * refuses a null leaf and does not visit an absent key, so a queue block in a naive log or a
 * restart block in a timing run cannot be "present and empty". A block the mode requires and the
 * harness did not supply, or one the mode has no place for, is refused before the walk names a
 * leaf, so the message says what is wrong with the run rather than which field is null.
 */
function requireBlocksForMode(input: RunLogInput): void {
  const expectedMode = variantMode(input.variant);
  if (input.mode !== expectedMode) {
    throw new Error(`run log variant ${input.variant} needs mode=${expectedMode}`);
  }
  if (input.mode === 'queue' && !input.queue) {
    throw new Error(
      'run log input is missing: queue (a queue run records what it observed of the fleet)',
    );
  }
  if (input.mode === 'naive' && input.queue) {
    throw new Error(
      'run log input has a queue block in naive mode, which has no workers to observe',
    );
  }
  if (input.mode === 'naive' && input.restart) {
    throw new Error('run log input has a restart block in naive mode, which has no worker to kill');
  }
  if (variantUsesReplica(input.variant) && !input.replica) {
    throw new Error(`run log variant ${input.variant} is missing its replica block`);
  }
  if (!variantUsesReplica(input.variant) && input.replica) {
    throw new Error(`run log variant ${input.variant} must not have a replica block`);
  }
}

export function buildRunLog(input: RunLogInput) {
  requireBlocksForMode(input);
  const missingInput = missingFields(input);
  if (missingInput.length > 0) {
    throw new Error(`run log input is missing: ${missingInput.join(', ')}`);
  }

  const { mode, variant, seed, sink, fanout, queue, restart, api, database, replica } = input;
  const checks = evaluateVerdict(input);
  const windowMs = durationMs(api.windowStartedAt, api.windowEndedAt);
  const expectedRequests = (api.requestsPerSecond * windowMs) / 1000;

  const log = {
    schema_version: RUN_LOG_SCHEMA_VERSION,
    milestone: runLogMilestone(variant),
    mode,
    variant,
    note: runLogNote(variant),
    base_commit: input.baseCommit,
    worktree_dirty: input.worktreeDirty,
    started_at: input.startedAt.toISOString(),
    ended_at: input.endedAt.toISOString(),
    seed: {
      target_date: seed.targetDate,
      peak_instant: seed.peakInstant.toISOString(),
      verified: seed.verified,
      pre_peak_reminders_marked_sent: seed.prePeakMarkedSent,
    },
    sink: {
      kind: 'simulated',
      // The sink module's constants, which is the only honest source for them here: the values a
      // send was actually made with were read by the sender's process, not this one — and are
      // graded from the record that process wrote, in `fanout.sender_records_observed`.
      pinned: {
        min_latency_ms: SIMULATED_SINK_DEFAULTS.minLatencyMs,
        max_latency_ms: SIMULATED_SINK_DEFAULTS.maxLatencyMs,
        failure_rate: SIMULATED_SINK_DEFAULTS.failureRate,
      },
      // What the fan-out paid, measured from the rows the sender wrote. `fanout.failed` beside it
      // is the failure side of the same observation and is not repeated here.
      observed: {
        min_latency_ms: sink.observedMinLatencyMs,
        max_latency_ms: sink.observedMaxLatencyMs,
        mean_latency_ms: sink.observedMeanLatencyMs,
      },
    },
    fanout: {
      reminders_at_peak: fanout.reminders,
      delivery_attempts: fanout.attempts,
      sent: fanout.sent,
      failed: fanout.failed,
      pending_after: fanout.pendingAfter,
      queued_after: fanout.queuedAfter,
      first_send_started_at: fanout.firstSendStartedAt.toISOString(),
      last_send_finished_at: fanout.lastSendFinishedAt.toISOString(),
      duration_ms: durationMs(fanout.firstSendStartedAt, fanout.lastSendFinishedAt),
      duration_seconds:
        Math.round(durationMs(fanout.firstSendStartedAt, fanout.lastSendFinishedAt) / 100) / 10,
      sender_records_observed: fanout.senderRecordsObserved,
      sends_without_sender_record: fanout.sendsWithoutSenderRecord,
    },
    ...(queue
      ? {
          queue: {
            workers: queue.workers,
            workers_observed: queue.workers.length,
            largest_claim_observed: queue.largestClaimObserved,
            duplicate_attempts: queue.duplicateAttempts,
          },
        }
      : {}),
    ...(restart
      ? {
          restart: {
            killed_worker: restart.killedWorker,
            killed_at: restart.killedAt.toISOString(),
            attempts_at_kill: restart.attemptsAtKill,
            jobs_held_at_kill: restart.jobsHeldAtKill,
            finished_by_killed_worker: restart.finishedByKilledWorker,
            finished_by_another_worker: restart.finishedByAnotherWorker,
            still_open_at_close: restart.stillOpenAtClose,
            ...(restart.firstReclaimAt
              ? { first_reclaim_at: restart.firstReclaimAt.toISOString() }
              : {}),
            // The fourth README cell. design.md "Jobs lost across worker restart" says why the
            // union of its two terms is this count and not their sum.
            jobs_lost: fanout.pendingAfter + fanout.queuedAfter,
          },
        }
      : {}),
    api: {
      url: api.url,
      pool_users: api.poolUsers,
      requests_per_second_target: api.requestsPerSecond,
      requests_total: api.requestsTotal,
      requests_skipped_for_backpressure: api.requestsSkipped,
      observed_window_started_at: api.windowStartedAt.toISOString(),
      observed_window_ended_at: api.windowEndedAt.toISOString(),
      requests_in_window: api.window.count,
      errors_in_window: api.window.errors,
      offered_rate: {
        window_seconds: windowMs / 1000,
        expected_requests: Math.round(expectedRequests * 100) / 100,
        observed_fraction:
          expectedRequests > 0
            ? Math.round((api.window.count / expectedRequests) * 10_000) / 10_000
            : 0,
        tolerance_percent: OFFERED_RATE_TOLERANCE_PERCENT,
      },
      p50_ms: api.window.p50Ms,
      p95_ms: api.window.p95Ms,
      p99_ms: api.window.p99Ms,
    },
    database: {
      transactions_per_second: transactionsPerSecond(database.before, database.after),
      counter_samples: [database.before, database.after].map((sample) => ({
        at: new Date(sample.atMs).toISOString(),
        xact_commit: sample.xactCommit,
        xact_rollback: sample.xactRollback,
      })),
      peak_connections: database.peakConnections,
      max_connections: database.maxConnections,
    },
    ...(replica
      ? {
          replica: {
            endpoint: replica.endpoint,
            transactions_per_second: transactionsPerSecond(replica.before, replica.after),
            counter_samples: [replica.before, replica.after].map((sample) => ({
              at: new Date(sample.atMs).toISOString(),
              xact_commit: sample.xactCommit,
              xact_rollback: sample.xactRollback,
            })),
          },
        }
      : {}),
    verdict: {
      met: checks.every((check) => check.met),
      checks,
    },
  };

  const missing = missingFields(log);
  if (missing.length > 0) {
    throw new Error(`run log is missing: ${missing.join(', ')}`);
  }
  return log;
}

/**
 * `load/results/<ISO instant>-<variant>.json`, with an optional `-restart` suffix and the colons
 * dropped so the name is a filename on every platform.
 */
export function runLogFileName(startedAt: Date, variant: LoadVariant, restart: boolean): string {
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
  const experiment = `${variant}${restart ? '-restart' : ''}`;
  return `${stamp}-${experiment}.json`;
}
