// The push sink contract: the one place that says what one send looks like.
//
// This module is shared with M2, whose workers import the same sink. M2 changes how sends are
// scheduled and must not change what a send costs, so the latency distribution in `simulated.ts`
// is pinned: changing it invalidates every committed comparison in README.md's measurement table.
// design.md "The push sink" owns the contract.

/** What one reminder's notification carries. M1 sends the same copy to every user. */
export type PushMessage = {
  title: string;
  body: string;
};

export type PushSendResult = {
  /** How long the send took, in milliseconds, as the sink itself measured it. */
  latencyMs: number;
};

/**
 * One send's addressee: a `push_tokens.token` exactly as stored, or `null` for a user with none
 * (`sendTargets`). The seeded population has none, and the simulated sink ignores the value.
 */
export type SendTarget = string | null;

/**
 * design.md "Send targets": the one rule both senders apply to the tokens they read. A reminder's
 * targets are its user's `push_tokens.token` values in the order the statement handed them
 * (`created_at, id`), or exactly `[null]` when the user has none, so a seeded reminder is one
 * send and every measured number stays one row per reminder. The simulated push distribution is
 * untouched by this rule; a user with two tokens costs two draws, which no measured run has.
 */
export function sendTargets(tokens: readonly string[]): SendTarget[] {
  return tokens.length === 0 ? [null] : [...tokens];
}

export interface PushSink {
  /**
   * Deliver one message, returning once the send has completed and throwing when it failed.
   *
   * `token` is one of `sendTargets`, `null` included: the seeded population has no registered
   * token, and the simulated sink ignores the value (design.md "The push sink").
   */
  send(token: SendTarget, message: PushMessage): Promise<PushSendResult>;
}

/**
 * A failed send that still knows how long it took.
 *
 * `deliveries.latency_ms` is not nullable and a failed attempt took real time, so the latency
 * travels on the error rather than being re-measured by the caller's clock.
 */
export class PushSendError extends Error {
  readonly latencyMs: number;

  constructor(message: string, latencyMs: number, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PushSendError';
    this.latencyMs = latencyMs;
  }
}
