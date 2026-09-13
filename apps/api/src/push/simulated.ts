// The simulated push sink: the only sink M1 ships, and the only one any measured number in
// README.md's table was produced against.
//
// SHARED WITH M2. Its workers import this module unchanged, because M2 is allowed to change how
// sends are scheduled and not what a send costs. Changing the latency distribution — the defaults
// below, or the PUSH_SIM_* values a run is given — invalidates every committed comparison: the M1
// and M2 rows would then be two different experiments rather than a before and an after.
//
// A run log therefore MEASURES the distribution rather than restating it. These values are read by
// whichever process sends, which is not the process that writes the log, so a log that copied
// PUSH_SIM_* out of its own environment would state parameters no send was made with. It records
// the defaults below, which are constants and not anyone's environment, beside the per-send cost
// the fan-out actually paid, and grades the two against each other.
//
// "Actually paid" is measured, not drawn: `send` reports the elapsed time on a monotonic clock
// around its wait, so the recorded cost sits above the drawn bounds by the timer's overshoot —
// small while M1 sends one at a time, larger once M2's workers contend for the event loop. A sink
// that reported its draw would record the same cost under both and hide exactly that difference.
// design.md "The push sink" owns the reasoning.

import { PushSendError, type PushSink } from './sink';

export type SimulatedSinkConfig = {
  /** Lower bound of the uniform per-send delay, in milliseconds. */
  minLatencyMs: number;
  /** Upper bound of the uniform per-send delay, in milliseconds. */
  maxLatencyMs: number;
  /** Fraction of sends that throw instead of succeeding, in `[0, 1]`. */
  failureRate: number;
};

/** The order of one real push call to a provider, and no failures unless a run asks for them. */
export const SIMULATED_SINK_DEFAULTS: SimulatedSinkConfig = {
  minLatencyMs: 50,
  maxLatencyMs: 150,
  failureRate: 0,
};

export const SIMULATED_SINK_ENV_NAMES = {
  minLatencyMs: 'PUSH_SIM_LATENCY_MIN_MS',
  maxLatencyMs: 'PUSH_SIM_LATENCY_MAX_MS',
  failureRate: 'PUSH_SIM_FAILURE_RATE',
} as const;

function readNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return value;
}

/** Reject a configuration rather than measuring against one nobody meant to set. */
export function validateSimulatedSinkConfig(config: SimulatedSinkConfig): SimulatedSinkConfig {
  const { minLatencyMs, maxLatencyMs, failureRate } = config;
  if (minLatencyMs < 0 || maxLatencyMs < minLatencyMs) {
    throw new Error(
      `simulated sink latency bounds must satisfy 0 <= min <= max, got ${minLatencyMs}..${maxLatencyMs}`,
    );
  }
  if (failureRate < 0 || failureRate > 1) {
    throw new Error(`simulated sink failure rate must be in 0..1, got ${failureRate}`);
  }
  return config;
}

export function readSimulatedSinkConfig(
  env: Record<string, string | undefined>,
): SimulatedSinkConfig {
  return validateSimulatedSinkConfig({
    minLatencyMs: readNumber(
      env,
      SIMULATED_SINK_ENV_NAMES.minLatencyMs,
      SIMULATED_SINK_DEFAULTS.minLatencyMs,
    ),
    maxLatencyMs: readNumber(
      env,
      SIMULATED_SINK_ENV_NAMES.maxLatencyMs,
      SIMULATED_SINK_DEFAULTS.maxLatencyMs,
    ),
    failureRate: readNumber(
      env,
      SIMULATED_SINK_ENV_NAMES.failureRate,
      SIMULATED_SINK_DEFAULTS.failureRate,
    ),
  });
}

/**
 * The delay one send sleeps for: uniform over the configured bounds, in whole milliseconds.
 *
 * Exported so the bounds are tested on the draw itself, without a timer. What the sink returns is
 * not this figure but the time the wait measurably cost (see `createSimulatedPushSink`).
 */
export function drawLatencyMs(config: SimulatedSinkConfig, random: () => number): number {
  return Math.round(config.minLatencyMs + random() * (config.maxLatencyMs - config.minLatencyMs));
}

/**
 * A sink that waits instead of calling a provider.
 *
 * The draw is the input to the wait; the returned `latencyMs` is its output, measured on a
 * monotonic clock around the sleep. The two differ by the timer's overshoot, which is small while
 * M1 sends one at a time and grows once M2's workers contend for the same event loop — and
 * `deliveries.latency_ms` is defined as what a send cost, not what it was told to cost
 * (design.md "The push sink"). A failed send carries the same measured figure on its error.
 *
 * `random` is injectable so the tests can pin a draw, and `now` so they can pin the clock; they
 * default to `Math.random` and `performance.now`.
 * A failure is drawn only when the rate is strictly between 0 and 1, so a rate of 1 throws for
 * every send whatever `random` returns and a rate of 0 never touches it.
 */
export function createSimulatedPushSink(
  config: SimulatedSinkConfig = SIMULATED_SINK_DEFAULTS,
  random: () => number = Math.random,
  now: () => number = () => performance.now(),
): PushSink {
  const validated = validateSimulatedSinkConfig(config);
  const { failureRate } = validated;

  return {
    async send() {
      const delayMs = drawLatencyMs(validated, random);
      const fails = failureRate >= 1 || (failureRate > 0 && random() < failureRate);
      const startedAt = now();
      await Bun.sleep(delayMs);
      const latencyMs = Math.round(now() - startedAt);
      if (fails) {
        throw new PushSendError(`simulated push failure after ${latencyMs}ms`, latencyMs);
      }
      return { latencyMs };
    },
  };
}
