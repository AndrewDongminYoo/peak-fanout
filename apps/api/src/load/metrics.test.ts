import { describe, expect, it } from 'bun:test';

import {
  durationMs,
  percentileMs,
  summarizeRequests,
  transactionsPerSecond,
  withinWindow,
  type RequestSample,
} from './metrics';

function sample(startedAt: number, durationMs: number, status = 200): RequestSample {
  return { startedAt, durationMs, status };
}

describe('percentileMs', () => {
  it('takes the nearest rank at or above the fraction', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(percentileMs(sorted, 0.5)).toBe(5);
    expect(percentileMs(sorted, 0.95)).toBe(10);
    expect(percentileMs(sorted, 1)).toBe(10);
  });

  it('handles a single sample', () => {
    expect(percentileMs([42], 0.95)).toBe(42);
  });

  it('refuses an empty list rather than reporting a fast zero', () => {
    expect(() => percentileMs([], 0.95)).toThrow('at least one sample');
  });

  it('refuses a fraction outside (0, 1]', () => {
    expect(() => percentileMs([1], 0)).toThrow('fraction must be in');
    expect(() => percentileMs([1], 1.5)).toThrow('fraction must be in');
  });
});

describe('withinWindow', () => {
  it('keeps the samples whose request started inside the window, boundaries included', () => {
    const samples = [sample(90, 1), sample(100, 1), sample(150, 1), sample(200, 1), sample(201, 1)];

    expect(withinWindow(samples, 100, 200).map((one) => one.startedAt)).toEqual([100, 150, 200]);
  });
});

describe('summarizeRequests', () => {
  it('counts anything that is not a 200 as an error', () => {
    const summary = summarizeRequests([
      sample(0, 10),
      sample(1, 20, 500),
      sample(2, 30, 0),
      sample(3, 40),
    ]);

    expect(summary).toEqual({ count: 4, errors: 2, p50Ms: 20, p95Ms: 40, p99Ms: 40 });
  });

  it('does not need the samples to arrive in order', () => {
    expect(summarizeRequests([sample(0, 90), sample(1, 10)]).p50Ms).toBe(10);
  });
});

describe('transactionsPerSecond', () => {
  it('divides the gained commits and rollbacks by the seconds between the samples', () => {
    const before = { atMs: 1_000, xactCommit: 100, xactRollback: 5 };
    const after = { atMs: 3_000, xactCommit: 1_100, xactRollback: 15 };

    expect(transactionsPerSecond(before, after)).toBe(505);
  });

  it('refuses two samples that are not apart in time', () => {
    const at = { atMs: 1_000, xactCommit: 1, xactRollback: 0 };

    expect(() => transactionsPerSecond(at, at)).toThrow('later than the first');
  });
});

describe('durationMs', () => {
  it('is the wall time between the first send starting and the last one finishing', () => {
    expect(
      durationMs(new Date('2026-09-15T12:00:00.000Z'), new Date('2026-09-15T12:13:20.000Z')),
    ).toBe(800_000);
  });
});
