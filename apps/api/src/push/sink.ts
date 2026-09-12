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

export interface PushSink {
  /**
   * Deliver one message, returning once the send has completed and throwing when it failed.
   *
   * `token` is `users.expo_push_token` exactly as stored, `null` included: the seeded population
   * has no registered token, and the simulated sink ignores the value (design.md "The push sink").
   */
  send(token: string | null, message: PushMessage): Promise<PushSendResult>;
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
