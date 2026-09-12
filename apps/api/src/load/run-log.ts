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
export const RUN_LOG_SCHEMA_VERSION = 3;

export const RUN_LOG_MILESTONE = 'M1 naive';

export const RUN_LOG_NOTE =
  'Single-machine localhost run: Postgres in docker compose, the API, the scheduler and the load ' +
  'generator all on one Mac, against the simulated push sink. Not a deployment measurement.';

export type VerdictCheck = {
  name: string;
  target: string;
  actual: string;
  met: boolean;
};

export type RunLogInput = {
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
   * each latency and the scheduler wrote it down.
   *
   * The pinned parameters are deliberately NOT an input. They are the sink module's constants, so
   * no caller can put its own `PUSH_SIM_*` environment where a measurement belongs — which is the
   * mistake version 2 made (design.md "The push sink").
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
    firstSendStartedAt: Date;
    lastSendFinishedAt: Date;
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
};

export type M1RunLog = ReturnType<typeof buildRunLog>;

/** What a send costs on average by design: the midpoint of the pinned uniform distribution. */
const PINNED_MEAN_LATENCY_MS =
  (SIMULATED_SINK_DEFAULTS.minLatencyMs + SIMULATED_SINK_DEFAULTS.maxLatencyMs) / 2;

/**
 * How far the measured mean send cost may sit from the pinned mean.
 *
 * Wide enough that a run never misses on its own draws and narrow enough to catch a changed
 * distribution in either direction; design.md "Metric definitions and their sources" derives the
 * figure from the distribution's standard error over the peak's 8,000 sends.
 */
export const SINK_MEAN_TOLERANCE_MS = 5;

/**
 * The checks a run is graded against; M1 has no target on the fan-out duration, by design.
 *
 * Each of these has to be reachable in a log the harness actually writes, or the verdict is
 * decoration. The two send-cost checks are reachable by a run that completes normally, with a
 * scheduler that was given other `PUSH_SIM_*` values — the one case a fully delivered fan-out
 * still has to read as a different experiment. The two that grade the fan-out are reachable
 * through the stall path: when the fan-out stops making progress the harness gives up, writes the
 * log anyway with the reminders that never left `pending`, and exits non-zero (`m1.ts`,
 * `waitForFanoutEnd`). A stall is the one outcome where both read false — reminders stay pending
 * and their attempts are missing.
 *
 * What is NOT graded here is refused upstream instead, before a log exists: nothing delivered at
 * all (`waitForFanoutStart`), and no request inside the window (`m1.ts` refuses rather than
 * summarizing an empty sample, since a p95 over nothing is not a measurement). Those are
 * preconditions of a measured run, not results of one, so the API check asks only about errors
 * and reports the in-window count beside them.
 */
export function evaluateVerdict(input: RunLogInput): VerdictCheck[] {
  const { fanout, api, sink } = input;
  return [
    {
      name: 'every reminder on the peak instant reached a terminal state',
      target: '0 still pending',
      actual: `${fanout.pendingAfter} still pending`,
      met: fanout.pendingAfter === 0,
    },
    {
      name: 'one delivery attempt recorded per peak reminder',
      target: `${fanout.reminders} attempts`,
      actual: `${fanout.attempts} attempts`,
      met: fanout.attempts === fanout.reminders,
    },
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
      actual:
        `${sink.observedMeanLatencyMs} ms mean over ${fanout.attempts} attempts, ` +
        `${sink.observedMinLatencyMs}..${sink.observedMaxLatencyMs} ms observed (bounds recorded, not graded)`,
      met: Math.abs(sink.observedMeanLatencyMs - PINNED_MEAN_LATENCY_MS) <= SINK_MEAN_TOLERANCE_MS,
    },
    {
      // The pinned failure rate is 0, so a single failed send says the sender's sink was not the
      // pinned one. A pinned rate above 0 would need a proportion test rather than this equality,
      // and would be a different experiment anyway.
      name: 'no send failed, as the pinned failure rate of 0 requires',
      target: '0 failed',
      actual: `${fanout.failed} failed of ${fanout.attempts} attempts`,
      met: fanout.failed === 0,
    },
  ];
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

export function buildRunLog(input: RunLogInput) {
  const missingInput = missingFields(input);
  if (missingInput.length > 0) {
    throw new Error(`run log input is missing: ${missingInput.join(', ')}`);
  }

  const { seed, sink, fanout, api, database } = input;
  const checks = evaluateVerdict(input);

  const log = {
    schema_version: RUN_LOG_SCHEMA_VERSION,
    milestone: RUN_LOG_MILESTONE,
    note: RUN_LOG_NOTE,
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
      // send was actually made with were read by the scheduler's process, not this one.
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
      first_send_started_at: fanout.firstSendStartedAt.toISOString(),
      last_send_finished_at: fanout.lastSendFinishedAt.toISOString(),
      duration_ms: durationMs(fanout.firstSendStartedAt, fanout.lastSendFinishedAt),
      duration_seconds:
        Math.round(durationMs(fanout.firstSendStartedAt, fanout.lastSendFinishedAt) / 100) / 10,
    },
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
 * `load/results/<ISO instant>-m1-naive.json`, with the colons dropped so the name is a filename
 * on every platform.
 */
export function runLogFileName(startedAt: Date): string {
  const stamp = startedAt
    .toISOString()
    .replace(/\.\d+Z$/, 'Z')
    .replaceAll(':', '-');
  return `${stamp}-m1-naive.json`;
}
