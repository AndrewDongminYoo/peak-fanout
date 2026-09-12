import { describe, expect, it } from 'bun:test';

import { PushSendError } from './sink';
import {
  createSimulatedPushSink,
  drawLatencyMs,
  readSimulatedSinkConfig,
  SIMULATED_SINK_DEFAULTS,
} from './simulated';

const MESSAGE = { title: 'title', body: 'body' };

/** A clock the test advances by hand, so a returned latency can only have come from it. */
function fakeClock(...readings: number[]): () => number {
  let next = 0;
  return () => {
    const reading = readings[next];
    if (reading === undefined)
      throw new Error('the fake clock was read more often than it was given');
    next += 1;
    return reading;
  };
}

/** Hold the event loop so no timer can fire until this returns. */
function busyWait(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // spin
  }
}

describe('drawLatencyMs', () => {
  it('maps the draw onto the configured bounds', () => {
    const bounds = { minLatencyMs: 50, maxLatencyMs: 150, failureRate: 0 };

    expect(drawLatencyMs(bounds, () => 0)).toBe(50);
    expect(drawLatencyMs(bounds, () => 0.5)).toBe(100);
    expect(drawLatencyMs(bounds, () => 0.999999)).toBe(150);
  });

  it('stays inside the default bounds over many draws', () => {
    const draws = Array.from({ length: 10_000 }, () =>
      drawLatencyMs(SIMULATED_SINK_DEFAULTS, Math.random),
    );

    expect(Math.min(...draws)).toBeGreaterThanOrEqual(SIMULATED_SINK_DEFAULTS.minLatencyMs);
    expect(Math.max(...draws)).toBeLessThanOrEqual(SIMULATED_SINK_DEFAULTS.maxLatencyMs);
  });
});

describe('createSimulatedPushSink', () => {
  it('returns the time the wait measurably cost, not the delay it drew', async () => {
    const sink = createSimulatedPushSink(
      { minLatencyMs: 50, maxLatencyMs: 150, failureRate: 0 },
      () => 0,
      fakeClock(1000, 1057.4),
    );

    await expect(sink.send(null, MESSAGE)).resolves.toEqual({ latencyMs: 57 });
  });

  it('pays the overshoot rather than hiding it behind the draw', async () => {
    // Real clock. The busy wait holds the event loop past the draw, so the timer cannot fire until
    // it ends; a sink that reported its draw would still say 20 here.
    const sink = createSimulatedPushSink({ minLatencyMs: 20, maxLatencyMs: 20, failureRate: 0 });

    const pending = sink.send('ExponentPushToken[abc]', MESSAGE);
    busyWait(120);
    const { latencyMs } = await pending;

    expect(latencyMs).toBeGreaterThanOrEqual(120);
  });

  it('waits at least as long as it drew', async () => {
    const sink = createSimulatedPushSink({ minLatencyMs: 30, maxLatencyMs: 30, failureRate: 0 });

    const startedAt = performance.now();
    const { latencyMs } = await sink.send(null, MESSAGE);
    const elapsed = performance.now() - startedAt;

    // Timers fire no earlier than their delay, so the measured cost is never below the draw; a
    // slow machine only pushes both figures up.
    expect(latencyMs).toBeGreaterThanOrEqual(30);
    expect(elapsed).toBeGreaterThanOrEqual(latencyMs - 1);
  });

  it('never fails at the default rate of 0', async () => {
    const sink = createSimulatedPushSink(SIMULATED_SINK_DEFAULTS, () => 0, fakeClock(0, 50));

    await expect(sink.send(null, MESSAGE)).resolves.toEqual({ latencyMs: 50 });
  });

  it('always throws at a failure rate of 1, whatever the draw is', async () => {
    const sink = createSimulatedPushSink(
      { minLatencyMs: 10, maxLatencyMs: 10, failureRate: 1 },
      () => 1,
    );

    await expect(sink.send(null, MESSAGE)).rejects.toThrow(PushSendError);
  });

  it('carries the measured latency on the failure, so a failed attempt still has one', async () => {
    const sink = createSimulatedPushSink(
      { minLatencyMs: 40, maxLatencyMs: 40, failureRate: 1 },
      () => 1,
      fakeClock(0, 43),
    );

    const error = (await sink.send(null, MESSAGE).catch((thrown: unknown) => thrown)) as
      PushSendError | undefined;

    expect(error).toBeInstanceOf(PushSendError);
    expect(error?.latencyMs).toBe(43);
    expect(error?.message).toBe('simulated push failure after 43ms');
  });

  it('refuses a configuration nobody meant to measure against', () => {
    expect(() =>
      createSimulatedPushSink({ minLatencyMs: 150, maxLatencyMs: 50, failureRate: 0 }),
    ).toThrow('0 <= min <= max');
    expect(() =>
      createSimulatedPushSink({ minLatencyMs: -1, maxLatencyMs: 50, failureRate: 0 }),
    ).toThrow('0 <= min <= max');
    expect(() =>
      createSimulatedPushSink({ minLatencyMs: 50, maxLatencyMs: 150, failureRate: 1.5 }),
    ).toThrow('failure rate must be in 0..1');
  });
});

describe('readSimulatedSinkConfig', () => {
  it('falls back to the pinned defaults when nothing is set', () => {
    expect(readSimulatedSinkConfig({})).toEqual(SIMULATED_SINK_DEFAULTS);
    expect(
      readSimulatedSinkConfig({
        PUSH_SIM_LATENCY_MIN_MS: '',
        PUSH_SIM_LATENCY_MAX_MS: '',
        PUSH_SIM_FAILURE_RATE: '',
      }),
    ).toEqual(SIMULATED_SINK_DEFAULTS);
  });

  it('reads the three PUSH_SIM_ values', () => {
    expect(
      readSimulatedSinkConfig({
        PUSH_SIM_LATENCY_MIN_MS: '5',
        PUSH_SIM_LATENCY_MAX_MS: '7',
        PUSH_SIM_FAILURE_RATE: '0.25',
      }),
    ).toEqual({ minLatencyMs: 5, maxLatencyMs: 7, failureRate: 0.25 });
  });

  it('refuses a value that is not a number instead of measuring against NaN', () => {
    expect(() => readSimulatedSinkConfig({ PUSH_SIM_LATENCY_MIN_MS: 'fast' })).toThrow(
      'PUSH_SIM_LATENCY_MIN_MS must be a number',
    );
  });
});
