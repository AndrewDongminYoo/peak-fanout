// The arithmetic behind the measured numbers, kept away from the harness's I/O so that it is
// testable without a database, an API or a clock. design.md "Metric definitions and their
// sources" owns what each number means.

/** One `GET /me` the load generator sent. */
export type RequestSample = {
  /** When the request was sent, as epoch milliseconds. */
  startedAt: number;
  durationMs: number;
  /** The HTTP status, or 0 when the request never got one (a transport failure). */
  status: number;
};

export type LatencySummary = {
  count: number;
  errors: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
};

/** `pg_stat_database` for the application database at one instant. */
export type CounterSample = {
  atMs: number;
  xactCommit: number;
  xactRollback: number;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Nearest-rank percentile over an ascending array: the smallest sample at or above `fraction` of
 * the distribution, which is what "p95" means for a latency list and needs no interpolation.
 *
 * An empty list throws rather than returning 0. A run with no sample inside the fan-out window
 * has not measured the API, and a 0 in that cell would read as a fast one.
 */
export function percentileMs(sortedAscending: number[], fraction: number): number {
  if (sortedAscending.length === 0) {
    throw new Error('percentileMs needs at least one sample');
  }
  if (fraction <= 0 || fraction > 1) {
    throw new Error(`percentile fraction must be in (0, 1], got ${fraction}`);
  }
  const rank = Math.ceil(fraction * sortedAscending.length) - 1;
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank));
  return round(sortedAscending[index] as number);
}

/** The samples whose request started inside `[fromMs, toMs]`. */
export function withinWindow(
  samples: RequestSample[],
  fromMs: number,
  toMs: number,
): RequestSample[] {
  return samples.filter((sample) => sample.startedAt >= fromMs && sample.startedAt <= toMs);
}

/** Anything that is not a 200 counts as an error; `GET /me` for a pool user has no other answer. */
export function summarizeRequests(samples: RequestSample[]): LatencySummary {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    count: samples.length,
    errors: samples.filter((sample) => sample.status !== 200).length,
    p50Ms: percentileMs(durations, 0.5),
    p95Ms: percentileMs(durations, 0.95),
    p99Ms: percentileMs(durations, 0.99),
  };
}

/**
 * `xact_commit + xact_rollback` gained between two samples, per second of the time between them.
 *
 * Stock Postgres 16 counts transactions and not statements (design.md "Metric definitions and
 * their sources"), so this is the figure the README column is named for.
 *
 * The counters are cumulative, so a second sample below the first means they were reset between
 * the two (`pg_stat_reset()`, or crash recovery restarting the statistics) and the delta measures
 * nothing. That throws rather than returning a negative rate, which is finite and would pass the
 * run log's checks into the README cell.
 */
export function transactionsPerSecond(before: CounterSample, after: CounterSample): number {
  const elapsedSeconds = (after.atMs - before.atMs) / 1000;
  if (elapsedSeconds <= 0) {
    throw new Error('transactionsPerSecond needs the second sample to be later than the first');
  }
  const transactions =
    after.xactCommit + after.xactRollback - (before.xactCommit + before.xactRollback);
  if (transactions < 0) {
    throw new Error('transactionsPerSecond saw the counters decreased between the samples');
  }
  return round(transactions / elapsedSeconds);
}

/** Milliseconds between two instants, which for the fan-out window is its duration. */
export function durationMs(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}
