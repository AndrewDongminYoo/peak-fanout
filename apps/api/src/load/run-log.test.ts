import { describe, expect, it } from 'bun:test';

import { SIMULATED_SINK_DEFAULTS } from '../push/simulated';
import {
  buildRunLog,
  runLogFileName,
  RUN_LOG_SCHEMA_VERSION,
  SINK_MEAN_TOLERANCE_MS,
  type RunLogInput,
} from './run-log';

const STARTED_AT = new Date('2026-09-15T11:59:00.000Z');
const FIRST_SEND = new Date('2026-09-15T12:00:00.000Z');
const LAST_SEND = new Date('2026-09-15T12:13:20.000Z');

function input(): RunLogInput {
  return {
    baseCommit: '0123456789abcdef0123456789abcdef01234567',
    worktreeDirty: true,
    startedAt: STARTED_AT,
    endedAt: new Date('2026-09-15T12:13:25.000Z'),
    seed: {
      targetDate: '2026-09-15',
      peakInstant: FIRST_SEND,
      verified: { seeded_users: '50000', reminders_at_peak: '8000' },
      prePeakMarkedSent: 36_000,
    },
    // What the sender's sink actually cost, as a run against the pinned distribution measures it.
    sink: { observedMinLatencyMs: 50, observedMaxLatencyMs: 150, observedMeanLatencyMs: 100.2 },
    fanout: {
      reminders: 8_000,
      attempts: 8_000,
      sent: 8_000,
      failed: 0,
      pendingAfter: 0,
      firstSendStartedAt: FIRST_SEND,
      lastSendFinishedAt: LAST_SEND,
    },
    api: {
      url: 'http://localhost:3000',
      poolUsers: 200,
      requestsPerSecond: 20,
      requestsTotal: 16_100,
      requestsSkipped: 0,
      windowStartedAt: FIRST_SEND,
      windowEndedAt: LAST_SEND,
      window: { count: 16_000, errors: 0, p50Ms: 3.2, p95Ms: 9.4, p99Ms: 21.5 },
    },
    database: {
      before: { atMs: FIRST_SEND.getTime(), xactCommit: 1_000, xactRollback: 0 },
      after: { atMs: LAST_SEND.getTime(), xactCommit: 41_000, xactRollback: 0 },
      peakConnections: 12,
      maxConnections: 100,
    },
  };
}

describe('buildRunLog', () => {
  it('carries every field a README cell or the run verdict is read from', () => {
    const log = buildRunLog(input());

    expect(log.schema_version).toBe(RUN_LOG_SCHEMA_VERSION);
    expect(log.milestone).toBe('M1 naive');
    expect(log.note).toContain('simulated push sink');
    // The commit the run sat on top of, and the flag that says the code under measurement was
    // not in it. A run performed in its own pull request always has both.
    expect(log.base_commit).toHaveLength(40);
    expect(log.worktree_dirty).toBe(true);
    expect(log.started_at).toBe('2026-09-15T11:59:00.000Z');
    expect(log.seed).toEqual({
      target_date: '2026-09-15',
      peak_instant: '2026-09-15T12:00:00.000Z',
      verified: { seeded_users: '50000', reminders_at_peak: '8000' },
      pre_peak_reminders_marked_sent: 36_000,
    });
    // The pinned parameters and what the fan-out actually paid, side by side, so a run whose
    // sender used other settings is visibly a different experiment rather than an improvement.
    expect(log.sink).toEqual({
      kind: 'simulated',
      pinned: { min_latency_ms: 50, max_latency_ms: 150, failure_rate: 0 },
      observed: { min_latency_ms: 50, max_latency_ms: 150, mean_latency_ms: 100.2 },
    });
    expect(log.fanout).toMatchObject({
      reminders_at_peak: 8_000,
      delivery_attempts: 8_000,
      sent: 8_000,
      failed: 0,
      pending_after: 0,
      duration_ms: 800_000,
      duration_seconds: 800,
    });
    expect(log.api).toMatchObject({
      requests_in_window: 16_000,
      errors_in_window: 0,
      p95_ms: 9.4,
      observed_window_started_at: '2026-09-15T12:00:00.000Z',
    });
    expect(log.database).toMatchObject({
      transactions_per_second: 50,
      peak_connections: 12,
      max_connections: 100,
    });
    expect(log.database.counter_samples).toEqual([
      { at: '2026-09-15T12:00:00.000Z', xact_commit: 1_000, xact_rollback: 0 },
      { at: '2026-09-15T12:13:20.000Z', xact_commit: 41_000, xact_rollback: 0 },
    ]);
    expect(log.verdict.met).toBe(true);
    expect(log.verdict.checks).toHaveLength(5);
  });

  it('takes the pinned sink parameters from the sink module and not from its input', () => {
    // The bug schema 3 exists for: the parameters a send was made with are read by the scheduler's
    // process, so nothing a caller passes here may stand in for them. `RunLogInput` carries only
    // the measurement, and these three come from the shared module.
    expect(buildRunLog(input()).sink.pinned).toEqual({
      min_latency_ms: SIMULATED_SINK_DEFAULTS.minLatencyMs,
      max_latency_ms: SIMULATED_SINK_DEFAULTS.maxLatencyMs,
      failure_rate: SIMULATED_SINK_DEFAULTS.failureRate,
    });
  });

  it('misses its verdict when the sends cost more than the pinned distribution', () => {
    // A scheduler started with PUSH_SIM_LATENCY_MAX_MS=1000 delivers every reminder and inflates
    // the fan-out. Before schema 3 the log read the harness's own 50..150 and said nothing.
    const wider = input();
    wider.sink = {
      observedMinLatencyMs: 51,
      observedMaxLatencyMs: 999,
      observedMeanLatencyMs: 525,
    };

    const log = buildRunLog(wider);

    expect(log.verdict.met).toBe(false);
    expect(log.verdict.checks[3]).toMatchObject({ target: '100 ms mean, within 5 ms', met: false });
    expect(log.verdict.checks[3]?.actual).toContain('525 ms mean over 8000 attempts');
  });

  it('misses its verdict when the sends cost less than the pinned distribution', () => {
    // The direction a bounds check cannot see and the one that would flatter M1 against M2: a
    // narrower distribution finishes the fan-out sooner while staying inside 50..150.
    const narrower = input();
    narrower.sink = {
      observedMinLatencyMs: 50,
      observedMaxLatencyMs: 60,
      observedMeanLatencyMs: 55,
    };

    expect(buildRunLog(narrower).verdict.met).toBe(false);
  });

  it('holds its verdict for a mean at the edge of the tolerance', () => {
    // The tolerance is for the distribution's own draws, so a run inside it must not miss.
    const edge = input();
    edge.sink.observedMeanLatencyMs = 100 + SINK_MEAN_TOLERANCE_MS;

    expect(buildRunLog(edge).verdict.met).toBe(true);
  });

  it('misses its verdict when a send failed, which the pinned failure rate of 0 forbids', () => {
    // Reachable by a run that otherwise completes: PUSH_SIM_FAILURE_RATE=1 on the scheduler still
    // records one attempt per reminder and leaves nothing pending.
    const failed = input();
    failed.fanout.sent = 7_990;
    failed.fanout.failed = 10;

    const log = buildRunLog(failed);

    expect(log.verdict.met).toBe(false);
    expect(log.verdict.checks[4]).toMatchObject({
      actual: '10 failed of 8000 attempts',
      met: false,
    });
  });

  it('keeps a clean worktree flag, which the completeness walk must not read as missing', () => {
    const clean = input();
    clean.worktreeDirty = false;

    // `false` is a value, not a gap: a walk that treated falsy as absent would refuse the one
    // run log whose code really was committed.
    expect(buildRunLog(clean).worktree_dirty).toBe(false);
  });

  it('names a metric that never arrived instead of writing null into a README cell', () => {
    const incomplete = input();
    incomplete.api.window.p95Ms = undefined as unknown as number;

    // The whole message, not just the path, so the test cannot pass on some other throw that
    // happens to name the same field.
    expect(() => buildRunLog(incomplete)).toThrow('run log input is missing: api.window.p95Ms');
  });

  it('refuses a run log with a whole section missing, rather than writing a partial one', () => {
    const incomplete = input();
    delete (incomplete.api as Partial<RunLogInput['api']>).window;

    // An absent key is not an empty value, so this one is caught by reading it rather than by the
    // completeness walk. Either way nothing is written: the test is that no log comes back.
    expect(() => buildRunLog(incomplete)).toThrow();
  });

  it('names a metric that arrived as NaN, which a division by an empty window produces', () => {
    const notANumber = input();
    notANumber.database.maxConnections = Number.NaN;

    expect(() => buildRunLog(notANumber)).toThrow(
      'run log input is missing: database.maxConnections',
    );
  });

  // Both fan-out checks are reached by the same run: a fan-out that stops making progress is
  // returned rather than thrown by `waitForFanoutEnd`, so the harness writes this log with the
  // reminders that never left `pending` and the attempts that were never recorded for them.
  it('misses its verdict when a reminder is still pending after the window', () => {
    const stalled = input();
    stalled.fanout.pendingAfter = 12;

    const log = buildRunLog(stalled);

    expect(log.verdict.met).toBe(false);
    expect(log.verdict.checks[0]).toMatchObject({ actual: '12 still pending', met: false });
  });

  it('misses its verdict when the attempts do not cover the peak', () => {
    const short = input();
    short.fanout.pendingAfter = 1;
    short.fanout.attempts = 7_999;

    expect(buildRunLog(short).verdict.met).toBe(false);
  });

  it('misses its verdict when the API failed a request during the window', () => {
    const errored = input();
    errored.api.window.errors = 3;

    expect(buildRunLog(errored).verdict.met).toBe(false);
  });

  it('reports the in-window request count beside the errors it graded', () => {
    // An empty window is not graded here: `m1.ts` refuses it before a log exists, because a p95
    // over no samples is not a measurement. The count travels with the check so a reader can see
    // how many requests the "0 errors" was over.
    expect(buildRunLog(input()).verdict.checks[2]).toMatchObject({
      actual: '0 errors in 16000 in-window requests',
      met: true,
    });
  });
});

describe('runLogFileName', () => {
  it('is the run start as an ISO instant, without characters a filename cannot hold', () => {
    expect(runLogFileName(STARTED_AT)).toBe('2026-09-15T11-59-00Z-m1-naive.json');
  });
});
