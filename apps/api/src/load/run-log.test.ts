import { describe, expect, it } from 'bun:test';

import { CARDS_CACHE_DEFAULTS } from '../cards/cache';
import { describeSender } from '../push/sender';
import { SIMULATED_SINK_DEFAULTS } from '../push/simulated';
import {
  buildRunLog,
  expectedSender,
  offeredRateHolds,
  runLogFileName,
  RUN_LOG_SCHEMA_VERSION,
  SINK_MEAN_TOLERANCE_MS,
  SINK_MIN_TOLERANCE_MS,
  stableJson,
  type LoadMode,
  type RunLogInput,
} from './run-log';

const STARTED_AT = new Date('2026-09-15T11:59:00.000Z');
const FIRST_SEND = new Date('2026-09-15T12:00:00.000Z');
const LAST_SEND = new Date('2026-09-15T12:13:20.000Z');

/**
 * A sender record as the database hands it back: `jsonb` orders keys by length and then bytes,
 * which is not the order `describeSender` writes them in. The fixture keeps that order so a
 * comparison that depended on key order would fail here and not only against Postgres.
 */
function recordAsJsonbReturnsIt(kind: 'naive' | 'worker', min = 50, max = 150, failureRate = 0) {
  return {
    kind,
    sink: {
      kind: 'simulated',
      failure_rate: failureRate,
      max_latency_ms: max,
      min_latency_ms: min,
    },
    ...(kind === 'worker'
      ? {
          cards: {
            cache: {
              enabled: true,
              fresh_ms: 60_000,
              stale_ms: 600_000,
              max_entries: 64,
            },
            read_database: 'primary',
          },
        }
      : {}),
  };
}

function input(mode: LoadMode = 'naive'): RunLogInput {
  return {
    mode,
    variant: mode === 'naive' ? 'm1-naive' : 'm2-queue',
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
      queuedAfter: 0,
      firstSendStartedAt: FIRST_SEND,
      lastSendFinishedAt: LAST_SEND,
      senderRecordsObserved: [recordAsJsonbReturnsIt(mode === 'naive' ? 'naive' : 'worker')],
      sendsWithoutSenderRecord: 0,
    },
    ...(mode === 'queue'
      ? {
          queue: {
            workers: ['mac.local:501', 'mac.local:502', 'mac.local:503', 'mac.local:504'],
            largestClaimObserved: 25,
            duplicateAttempts: 0,
          },
        }
      : {}),
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
  it('writes schema 6 with an explicit variant and a note that describes the actual mode', () => {
    const naive = buildRunLog({ ...input(), variant: 'm1-naive' } as RunLogInput);
    const queue = buildRunLog({ ...input('queue'), variant: 'm2-queue' } as RunLogInput);

    expect(naive.schema_version).toBe(6);
    expect(naive.variant).toBe('m1-naive');
    expect(naive.note).not.toContain('workers');
    expect(queue.variant).toBe('m2-queue');
    expect(queue.note).toContain('workers');
    expect(() => buildRunLog({ ...input('queue'), variant: 'm1-naive' } as RunLogInput)).toThrow(
      'run log variant m1-naive needs mode=naive',
    );
  });

  it('writes complete replica counters only for a replica variant', () => {
    const replica = buildRunLog({
      ...input('queue'),
      variant: 'm3-replica-cache-off',
      replica: {
        endpoint: 'localhost:5433/peak',
        before: { atMs: FIRST_SEND.getTime(), xactCommit: 100, xactRollback: 2 },
        after: { atMs: LAST_SEND.getTime(), xactCommit: 16_102, xactRollback: 2 },
      },
    } as RunLogInput);

    expect(replica.replica).toEqual({
      endpoint: 'localhost:5433/peak',
      transactions_per_second: 20,
      counter_samples: [
        { at: '2026-09-15T12:00:00.000Z', xact_commit: 100, xact_rollback: 2 },
        { at: '2026-09-15T12:13:20.000Z', xact_commit: 16_102, xact_rollback: 2 },
      ],
    });

    expect(() =>
      buildRunLog({ ...input('queue'), variant: 'm3-replica-cache-on' } as RunLogInput),
    ).toThrow(/replica block/);
    expect(() =>
      buildRunLog({
        ...input('queue'),
        variant: 'm3-primary-cache-off',
        replica: {
          endpoint: 'localhost:5433/peak',
          before: { atMs: FIRST_SEND.getTime(), xactCommit: 1, xactRollback: 0 },
          after: { atMs: LAST_SEND.getTime(), xactCommit: 2, xactRollback: 0 },
        },
      } as RunLogInput),
    ).toThrow(/replica block/);
  });

  it('carries every field a README cell or the run verdict is read from', () => {
    const log = buildRunLog(input());

    expect(log.schema_version).toBe(RUN_LOG_SCHEMA_VERSION);
    expect(log.milestone).toBe('M1 naive');
    expect(log.mode).toBe('naive');
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
      queued_after: 0,
      duration_ms: 800_000,
      duration_seconds: 800,
      sends_without_sender_record: 0,
    });
    expect(log.fanout.sender_records_observed).toHaveLength(1);
    expect(log.api).toMatchObject({
      requests_in_window: 16_000,
      errors_in_window: 0,
      p95_ms: 9.4,
      observed_window_started_at: '2026-09-15T12:00:00.000Z',
      offered_rate: {
        window_seconds: 800,
        expected_requests: 16_000,
        observed_fraction: 1,
        tolerance_percent: 5,
      },
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
    expect(log.verdict.checks).toHaveLength(8);
    // A naive log has no queue and no restart block: absent, not null, so the completeness walk
    // has nothing to refuse and a reader has nothing to misread as a measurement.
    expect('queue' in log).toBe(false);
    expect('restart' in log).toBe(false);
  });

  it('names the M2 milestone and carries the queue block as observed in queue mode', () => {
    const log = buildRunLog(input('queue'));

    expect(log.milestone).toBe('M2 queue');
    expect(log.mode).toBe('queue');
    expect(log.queue).toEqual({
      workers: ['mac.local:501', 'mac.local:502', 'mac.local:503', 'mac.local:504'],
      workers_observed: 4,
      largest_claim_observed: 25,
      duplicate_attempts: 0,
    });
    expect('restart' in log).toBe(false);
    expect(log.verdict.met).toBe(true);
    expect(log.verdict.checks).toHaveLength(8);
  });

  it('refuses a queue run without its queue block, and a naive run with one', () => {
    const missing = input('queue');
    delete missing.queue;
    expect(() => buildRunLog(missing)).toThrow('run log input is missing: queue');

    const stray = input('naive');
    stray.queue = { workers: [], largestClaimObserved: 0, duplicateAttempts: 0 };
    expect(() => buildRunLog(stray)).toThrow('queue block in naive mode');
  });

  it('grades the attempts exactly in naive mode and at least once in queue mode', () => {
    // The naive sender records one attempt per reminder, as M1's contract says. The queue is
    // at-least-once: a lease reclaim sends a reminder twice and both rows are true, so the check
    // is >= and the duplicate count travels with it (design.md "Duplicate attempts").
    const naiveOver = input('naive');
    naiveOver.fanout.attempts = 8_003;
    expect(buildRunLog(naiveOver).verdict.checks[1]).toMatchObject({
      name: 'one delivery attempt recorded per peak reminder',
      actual: '8003 attempts',
      met: false,
    });

    const queueOver = input('queue');
    queueOver.fanout.attempts = 8_003;
    (queueOver.queue as NonNullable<RunLogInput['queue']>).duplicateAttempts = 3;
    expect(buildRunLog(queueOver).verdict.checks[1]).toMatchObject({
      name: 'at least one delivery attempt recorded per peak reminder',
      target: 'at least 8000 attempts',
      actual: '8003 attempts, 3 of them duplicates',
      met: true,
    });

    const queueShort = input('queue');
    queueShort.fanout.attempts = 7_999;
    queueShort.fanout.queuedAfter = 1;
    expect(buildRunLog(queueShort).verdict.checks[1]?.met).toBe(false);
  });

  it('misses its verdict when a reminder is still queued after the window', () => {
    // The queue's own non-terminal state: a job that exists and was never finished. Reachable by
    // a stall in queue mode, where every peak reminder is `queued` within the first second.
    const stalled = input('queue');
    stalled.fanout.queuedAfter = 25;
    stalled.fanout.attempts = 7_975;

    const log = buildRunLog(stalled);

    expect(log.verdict.met).toBe(false);
    expect(log.verdict.checks[0]).toMatchObject({
      target: '0 still pending or queued',
      actual: '0 still pending, 25 still queued',
      met: false,
    });
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

  it('misses its verdict for a distribution that shares the pinned midpoint but not its bounds', () => {
    // The evasion the mean check alone cannot see: PUSH_SIM_LATENCY_MIN_MS=0 with
    // PUSH_SIM_LATENCY_MAX_MS=200 averages 100 ms, fails no send, and would be committed as
    // comparable — while measuring a different experiment. Where the smallest send landed tells.
    const symmetric = input();
    symmetric.sink = {
      observedMinLatencyMs: 0,
      observedMaxLatencyMs: 200,
      observedMeanLatencyMs: 100.1,
    };

    const log = buildRunLog(symmetric);

    expect(log.verdict.met).toBe(false);
    expect(log.verdict.checks[4]).toMatchObject({
      name: 'the fan-out drew its send costs from the pinned bounds',
      met: false,
    });
    expect(log.verdict.checks[4]?.actual).toBe('0..200 ms observed');
    // And the mean check, on its own, would have let it through.
    expect(log.verdict.checks[3]?.met).toBe(true);
  });

  it('holds its verdict for the bounds a real run produces, timer overshoot included', () => {
    // The committed run read 51..153: the smallest draw a millisecond past the bound, the
    // largest three past it, because a timer fires late under load and never early. That shape
    // has to pass, or the check would fail every honest run on a busy machine.
    const real = input();
    real.sink = {
      observedMinLatencyMs: 51,
      observedMaxLatencyMs: 153,
      observedMeanLatencyMs: 102.07,
    };

    const log = buildRunLog(real);

    expect(log.verdict.met).toBe(true);
    expect(log.verdict.checks[4]?.met).toBe(true);
  });

  it('misses its verdict when the smallest send sits past the minimum tolerance', () => {
    // A narrower distribution that keeps the midpoint, 60..140, is caught at both ends: the
    // smallest send is ten milliseconds above the pinned minimum and the largest never reaches
    // the pinned maximum. The edge of the tolerance itself still passes.
    const narrower = input();
    narrower.sink = {
      observedMinLatencyMs: 60,
      observedMaxLatencyMs: 140,
      observedMeanLatencyMs: 100,
    };
    expect(buildRunLog(narrower).verdict.checks[4]?.met).toBe(false);

    const edge = input();
    edge.sink = {
      observedMinLatencyMs: 50 + SINK_MIN_TOLERANCE_MS,
      observedMaxLatencyMs: 150,
      observedMeanLatencyMs: 100,
    };
    expect(buildRunLog(edge).verdict.checks[4]?.met).toBe(true);
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
    expect(log.verdict.checks[5]).toMatchObject({
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
    expect(log.verdict.checks[0]).toMatchObject({
      actual: '12 still pending, 0 still queued',
      met: false,
    });
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

describe('the offered-rate check (#26)', () => {
  /**
   * The window of the 2026-09-12 schema-4 M1 log the tolerance was calibrated on, on the harness's
   * clock, as that log recorded it. Its numbers stay here as the calibration point whatever the
   * schema-5 re-measurement records.
   */
  const M1_WINDOW_STARTED_AT = new Date('2026-09-12T19:07:57.394Z');
  const M1_WINDOW_ENDED_AT = new Date('2026-09-12T19:22:24.216Z');

  it('holds the 2026-09-12 schema-4 calibration baseline, which offered 96.8% of its target on a loaded machine', () => {
    // 866.822 s at 20/s is 17,336.44 expected; that log's 16,777 in-window requests clear the 95%
    // floor by some 300. The gate was calibrated on this run and must not reject it.
    const baseline = input();
    baseline.api.windowStartedAt = M1_WINDOW_STARTED_AT;
    baseline.api.windowEndedAt = M1_WINDOW_ENDED_AT;
    baseline.api.window.count = 16_777;

    const log = buildRunLog(baseline);

    expect(log.verdict.checks[6]).toMatchObject({
      name: 'the load generator offered its target rate over the observed window',
      target: 'at least 95% of 20/s over 866.822 s (17336.44 requests)',
      actual: '16777 requests in window',
      met: true,
    });
    expect(log.api.offered_rate).toEqual({
      window_seconds: 866.822,
      expected_requests: 17_336.44,
      observed_fraction: 0.9677,
      tolerance_percent: 5,
    });
  });

  it('holds at exactly 95% and misses one request below it, on the long window', () => {
    // 866 s at 20/s: 17,320 expected, 16,454 is exactly 95% of it. Integer arithmetic, so the
    // edge does not turn on how 0.95 rounds in binary.
    const windowMs = 866_000;
    expect(offeredRateHolds(16_454, 20, windowMs)).toBe(true);
    expect(offeredRateHolds(16_453, 20, windowMs)).toBe(false);
  });

  it('holds at exactly 95% and misses one request below it, on the short window', () => {
    // An M2 window: 20 s at 20/s is 400 expected, 380 is exactly 95%. The same rule at both
    // lengths, which is why there is no separate absolute floor.
    const short = input('queue');
    short.api.windowStartedAt = new Date('2026-09-15T12:00:00.000Z');
    short.api.windowEndedAt = new Date('2026-09-15T12:00:20.000Z');
    short.api.window.count = 380;
    expect(buildRunLog(short).verdict.checks[6]?.met).toBe(true);

    short.api.window.count = 379;
    const log = buildRunLog(short);
    expect(log.verdict.met).toBe(false);
    expect(log.verdict.checks[6]).toMatchObject({
      target: 'at least 95% of 20/s over 20 s (400 requests)',
      actual: '379 requests in window',
      met: false,
    });
  });

  it('grades the count and not the skip counter, so a late timer is caught with no beat skipped', () => {
    // The second mechanism in #26: the timer fires late and replays nothing, and the skip counter
    // stays 0. A check on the counter would pass this run; the count does not.
    const lagging = input();
    lagging.api.requestsSkipped = 0;
    lagging.api.window.count = 15_000;

    expect(buildRunLog(lagging).verdict.checks[6]?.met).toBe(false);
  });
});

describe('the sender record check (#25)', () => {
  it('builds the expected record from the sink module constants under the mode kind', () => {
    // Never from the harness's environment: the same rule the pinned block follows.
    expect(expectedSender('m1-naive')).toEqual(describeSender('naive', SIMULATED_SINK_DEFAULTS));
    expect(expectedSender('m2-queue')).toEqual(
      describeSender('worker', SIMULATED_SINK_DEFAULTS, {
        cache: CARDS_CACHE_DEFAULTS,
        readDatabase: 'primary',
      }),
    );
    expect(expectedSender('m3-replica-cache-on', 'localhost:5433/peak')).toMatchObject({
      cards: {
        read_database: 'replica',
        read_endpoint: 'localhost:5433/peak',
      },
    });
    expect(expectedSender('m2-queue').sink).toEqual({
      kind: 'simulated',
      min_latency_ms: 50,
      max_latency_ms: 150,
      failure_rate: 0,
    });
  });

  it('holds on exactly one record equal to the expected one, whatever order jsonb returned its keys in', () => {
    // The fixture's keys are in jsonb's order (length, then bytes), not the writer's; the check
    // compares what the records hold. `JSON.stringify` on the two would disagree.
    const log = buildRunLog(input());

    expect(JSON.stringify(recordAsJsonbReturnsIt('naive'))).not.toBe(
      JSON.stringify(expectedSender('m1-naive')),
    );
    expect(stableJson(recordAsJsonbReturnsIt('naive'))).toBe(
      stableJson(expectedSender('m1-naive')),
    );
    expect(log.verdict.checks[7]).toMatchObject({
      name: 'every peak delivery carries the one pinned sender record',
      met: true,
    });
    expect(log.verdict.checks[7]?.actual).toBe(
      `1 distinct record, 0 sends without one: ${stableJson(expectedSender('m1-naive'))}`,
    );
  });

  it('misses on the issue own 51..149 example, which every measured-cost check admits', () => {
    // PUSH_SIM_LATENCY_MIN_MS=51 PUSH_SIM_LATENCY_MAX_MS=149: the smallest cost lands inside the
    // 2 ms tolerance, the largest reaches 150 after overshoot, the mean sits near 100 — and the
    // record the sender wrote says 51 and 149. Before schema 5 this run was committed as
    // comparable.
    const shifted = input();
    shifted.sink = {
      observedMinLatencyMs: 51,
      observedMaxLatencyMs: 152,
      observedMeanLatencyMs: 101.9,
    };
    shifted.fanout.senderRecordsObserved = [recordAsJsonbReturnsIt('naive', 51, 149)];

    const log = buildRunLog(shifted);

    expect(log.verdict.checks[3]?.met).toBe(true);
    expect(log.verdict.checks[4]?.met).toBe(true);
    expect(log.verdict.checks[7]?.met).toBe(false);
    expect(log.verdict.met).toBe(false);
  });

  it('misses on a send without a record, which is a sender that recorded nothing', () => {
    const unrecorded = input();
    unrecorded.fanout.sendsWithoutSenderRecord = 1;

    const log = buildRunLog(unrecorded);

    expect(log.verdict.checks[7]).toMatchObject({ met: false });
    expect(log.verdict.checks[7]?.actual).toContain('1 sends without one');
  });

  it('misses on a second distinct record, which is two senders with different settings', () => {
    const mixed = input();
    mixed.fanout.senderRecordsObserved = [
      recordAsJsonbReturnsIt('naive'),
      recordAsJsonbReturnsIt('naive', 50, 150, 0.01),
    ];

    const log = buildRunLog(mixed);

    expect(log.verdict.checks[7]?.met).toBe(false);
    expect(log.verdict.checks[7]?.actual).toContain('2 distinct records');
  });

  it('misses on the other mode kind: a naive scheduler under a queue run', () => {
    // The wrong SCHEDULER_MODE delivers everything and writes `naive` records; the log then says
    // which sender it measured instead of filling the M2 row with the M1 sender.
    const wrongMode = input('queue');
    wrongMode.fanout.senderRecordsObserved = [recordAsJsonbReturnsIt('naive')];

    expect(buildRunLog(wrongMode).verdict.checks[7]?.met).toBe(false);
  });

  it('records the observed records as values, not text, so a reader sees what was written', () => {
    const log = buildRunLog(input('queue'));

    expect(log.fanout.sender_records_observed).toEqual([recordAsJsonbReturnsIt('worker')]);
  });

  it('grades the M3 cache setting and read route, not only the worker kind', () => {
    const baseline = input('queue');
    const expectedRecord = {
      ...recordAsJsonbReturnsIt('worker'),
      cards: {
        cache: {
          enabled: false,
          fresh_ms: CARDS_CACHE_DEFAULTS.freshMs,
          stale_ms: CARDS_CACHE_DEFAULTS.staleMs,
          max_entries: CARDS_CACHE_DEFAULTS.maxEntries,
        },
        read_database: 'primary',
      },
    };
    const m3 = {
      ...baseline,
      variant: 'm3-primary-cache-off' as const,
      fanout: { ...baseline.fanout, senderRecordsObserved: [expectedRecord] },
    };

    expect(buildRunLog(m3).verdict.checks[7]?.met).toBe(true);
    expect(
      buildRunLog({
        ...m3,
        fanout: {
          ...m3.fanout,
          senderRecordsObserved: [
            {
              ...expectedRecord,
              cards: { ...expectedRecord.cards, read_database: 'replica' },
            },
          ],
        },
      }).verdict.checks[7]?.met,
    ).toBe(false);
    expect(
      buildRunLog({
        ...m3,
        fanout: {
          ...m3.fanout,
          senderRecordsObserved: [
            {
              ...expectedRecord,
              cards: {
                ...expectedRecord.cards,
                cache: { ...expectedRecord.cards.cache, enabled: true },
              },
            },
          ],
        },
      }).verdict.checks[7]?.met,
    ).toBe(false);
  });

  it('binds a replica worker record to the endpoint whose counters the harness sampled', () => {
    const baseline = input('queue');
    const endpoint = 'localhost:5433/peak';
    const replica = {
      ...baseline,
      variant: 'm3-replica-cache-on' as const,
      replica: {
        endpoint,
        before: { atMs: FIRST_SEND.getTime(), xactCommit: 100, xactRollback: 0 },
        after: { atMs: LAST_SEND.getTime(), xactCommit: 200, xactRollback: 0 },
      },
      fanout: {
        ...baseline.fanout,
        senderRecordsObserved: [expectedSender('m3-replica-cache-on', endpoint)],
      },
    };

    expect(buildRunLog(replica).verdict.checks[7]?.met).toBe(true);
    expect(
      buildRunLog({
        ...replica,
        fanout: {
          ...replica.fanout,
          senderRecordsObserved: [expectedSender('m3-replica-cache-on', 'localhost:5999/peak')],
        },
      }).verdict.checks[7]?.met,
    ).toBe(false);
  });
});

describe('the restart block and its ninth check', () => {
  const KILLED_AT = new Date('2026-09-15T12:00:05.000Z');
  const RECLAIMED_AT = new Date('2026-09-15T12:00:35.000Z');

  function restartInput(): RunLogInput {
    const base = input('queue');
    base.fanout.attempts = 8_004;
    (base.queue as NonNullable<RunLogInput['queue']>).duplicateAttempts = 4;
    base.restart = {
      killedWorker: 'mac.local:503',
      killedAt: KILLED_AT,
      attemptsAtKill: 2_050,
      jobsHeldAtKill: 25,
      finishedByKilledWorker: 4,
      finishedByAnotherWorker: 21,
      stillOpenAtClose: 0,
      firstReclaimAt: RECLAIMED_AT,
    };
    return base;
  }

  it('appears only with a restart block, and holds when nothing was lost', () => {
    const log = buildRunLog(restartInput());

    expect(log.verdict.checks).toHaveLength(9);
    expect(log.restart).toEqual({
      killed_worker: 'mac.local:503',
      killed_at: '2026-09-15T12:00:05.000Z',
      attempts_at_kill: 2_050,
      jobs_held_at_kill: 25,
      finished_by_killed_worker: 4,
      finished_by_another_worker: 21,
      still_open_at_close: 0,
      first_reclaim_at: '2026-09-15T12:00:35.000Z',
      jobs_lost: 0,
    });
    expect(log.verdict.checks[8]).toMatchObject({
      name: 'no job was lost across the worker restart',
      target: '0 lost',
      met: true,
    });
    expect(log.verdict.checks[8]?.actual).toContain('21 reclaimed and finished by another worker');
    // The duplicates are the killed worker's sends that were never recorded and went out twice.
    expect(log.verdict.checks[1]?.met).toBe(true);
    expect(log.verdict.met).toBe(true);
  });

  it('misses when a held job is still open at close, which a lease outlasting the stall timeout produces', () => {
    const stalled = restartInput();
    (stalled.restart as NonNullable<RunLogInput['restart']>).stillOpenAtClose = 21;
    (stalled.restart as NonNullable<RunLogInput['restart']>).finishedByAnotherWorker = 0;
    delete (stalled.restart as NonNullable<RunLogInput['restart']>).firstReclaimAt;
    stalled.fanout.queuedAfter = 21;
    stalled.fanout.attempts = 7_979;

    const log = buildRunLog(stalled);

    expect(log.restart?.jobs_lost).toBe(21);
    expect('first_reclaim_at' in (log.restart ?? {})).toBe(false);
    expect(log.verdict.checks[8]).toMatchObject({ met: false });
    expect(log.verdict.checks[8]?.actual).toContain('21 lost');
    expect(log.verdict.checks[8]?.actual).toContain('21 still open');
    expect(log.verdict.met).toBe(false);
  });

  it('refuses a restart block in naive mode', () => {
    const naive = input('naive');
    naive.restart = restartInput().restart as NonNullable<RunLogInput['restart']>;

    expect(() => buildRunLog(naive)).toThrow('restart block in naive mode');
  });

  it('still refuses a null leaf inside an optional block', () => {
    const broken = restartInput();
    (broken.restart as NonNullable<RunLogInput['restart']>).attemptsAtKill =
      undefined as unknown as number;

    expect(() => buildRunLog(broken)).toThrow('run log input is missing: restart.attemptsAtKill');
  });
});

describe('runLogFileName', () => {
  it('is the run start as an ISO instant, without characters a filename cannot hold', () => {
    expect(runLogFileName(STARTED_AT, 'm1-naive', false)).toBe(
      '2026-09-15T11-59-00Z-m1-naive.json',
    );
  });

  it('names the experiment: the queue timing run and the queue restart run', () => {
    expect(runLogFileName(STARTED_AT, 'm2-queue', false)).toBe(
      '2026-09-15T11-59-00Z-m2-queue.json',
    );
    expect(runLogFileName(STARTED_AT, 'm2-queue', true)).toBe(
      '2026-09-15T11-59-00Z-m2-queue-restart.json',
    );
  });

  it('names each M3 variant and keeps restart as a suffix', () => {
    expect(runLogFileName(STARTED_AT, 'm3-primary-cache-off', false)).toBe(
      '2026-09-15T11-59-00Z-m3-primary-cache-off.json',
    );
    expect(runLogFileName(STARTED_AT, 'm3-replica-cache-on', true)).toBe(
      '2026-09-15T11-59-00Z-m3-replica-cache-on-restart.json',
    );
  });
});
