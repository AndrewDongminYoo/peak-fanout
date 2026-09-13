// The sender record: what `deliveries.sender` holds, and the one builder that produces it.
//
// A sibling of the sink and not a change to it. `simulated.ts` is shared with every milestone and
// stays byte-identical; the record is assembled by the process that sends — the naive scheduler
// or the worker — from the `SimulatedSinkConfig` it already reads at start, and handed to its
// repository, which writes it on every `deliveries` row it inserts. The run log's verdict then
// grades the record against the module's pinned constants beside the measured send costs, which
// is what closes the case measurement cannot: a sender shifted by less than the tolerance
// (#25, design.md "The push sink" and "Data model").
//
// The keys are snake_case because the record is a database value read back by SQL and by a
// reader of the run log, not a TypeScript object anyone else consumes.

import type { SimulatedSinkConfig } from './simulated';

/** Which process wrote the row: the naive scheduler under `SCHEDULER_MODE=naive`, or a worker. */
export type DeliverySenderKind = 'naive' | 'worker';

export type DeliverySender = {
  kind: DeliverySenderKind;
  sink: {
    kind: 'simulated';
    min_latency_ms: number;
    max_latency_ms: number;
    failure_rate: number;
  };
};

/** The record a sender writes: its kind, and the sink settings it read. */
export function describeSender(
  kind: DeliverySenderKind,
  sink: SimulatedSinkConfig,
): DeliverySender {
  return {
    kind,
    sink: {
      kind: 'simulated',
      min_latency_ms: sink.minLatencyMs,
      max_latency_ms: sink.maxLatencyMs,
      failure_rate: sink.failureRate,
    },
  };
}
