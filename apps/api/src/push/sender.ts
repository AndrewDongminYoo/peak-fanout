// The sender record: what `deliveries.sender` holds, and the one builder that produces it.
//
// A sibling of the sink and not a change to it. `simulated.ts` is shared with every milestone and
// stays byte-identical. The naive scheduler records its `SimulatedSinkConfig`. A worker records
// either that same configuration or the Expo sink with only a push-security boolean. The process
// hands the record to its repository, which writes it on every `deliveries` row it inserts. The
// run log's verdict grades measured runs against the pinned simulation, which is what closes the
// case measurement cannot: a sender shifted by less than the tolerance (#25, design.md "The push
// sink" and "Data model").
//
// The keys are snake_case because the record is a database value read back by SQL and by a
// reader of the run log, not a TypeScript object anyone else consumes.

import type { CardsCacheConfig } from '../cards/cache';
import type { ExpoSenderConfig } from './expo';
import type { SimulatedSinkConfig } from './simulated';

/** Which process wrote the row: the naive scheduler under `SCHEDULER_MODE=naive`, or a worker. */
export type DeliverySenderKind = 'naive' | 'worker';

type SimulatedDeliverySinkRecord = {
  kind: 'simulated';
  min_latency_ms: number;
  max_latency_ms: number;
  failure_rate: number;
};

type ExpoDeliverySinkRecord = {
  kind: 'expo';
  access_token_configured: boolean;
};

type DeliverySinkRecord = {
  sink: SimulatedDeliverySinkRecord | ExpoDeliverySinkRecord;
};

type NaiveSinkRecord = {
  sink: SimulatedDeliverySinkRecord;
};

type WorkerSinkConfig = SimulatedSinkConfig | ExpoSenderConfig;

export type CardsReadDatabase = 'primary' | 'replica';

export type WorkerCardsConfig = {
  cache: CardsCacheConfig;
  readDatabase: CardsReadDatabase;
  /** Credential-free identity of the verified standby; absent for a shared primary pool. */
  readEndpoint?: string;
};

export type NaiveDeliverySender = NaiveSinkRecord & { kind: 'naive' };

export type WorkerDeliverySender = DeliverySinkRecord & {
  kind: 'worker';
  cards: {
    read_database: CardsReadDatabase;
    read_endpoint?: string;
    cache: {
      enabled: boolean;
      fresh_ms: number;
      stale_ms: number;
      max_entries: number;
    };
  };
};

export type DeliverySender = NaiveDeliverySender | WorkerDeliverySender;

/** The record a sender writes: its kind, and the sink settings it read. */
export function describeSender(kind: 'naive', sink: SimulatedSinkConfig): NaiveDeliverySender;
export function describeSender(
  kind: 'worker',
  sink: WorkerSinkConfig,
  cards: WorkerCardsConfig,
): WorkerDeliverySender;
export function describeSender(
  kind: DeliverySenderKind,
  sink: WorkerSinkConfig,
  cards?: WorkerCardsConfig,
): DeliverySender {
  if (kind === 'naive') {
    if ('kind' in sink) throw new Error('the naive sender uses the simulated sink');
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
  const sinkRecord: DeliverySinkRecord['sink'] =
    'kind' in sink
      ? { kind: 'expo', access_token_configured: sink.accessTokenConfigured }
      : {
          kind: 'simulated',
          min_latency_ms: sink.minLatencyMs,
          max_latency_ms: sink.maxLatencyMs,
          failure_rate: sink.failureRate,
        };
  if (!cards) throw new Error('a worker sender needs its cards configuration');
  if (cards.readDatabase === 'replica' && !cards.readEndpoint) {
    throw new Error('a replica worker sender needs its verified read endpoint');
  }
  if (cards.readDatabase === 'primary' && cards.readEndpoint) {
    throw new Error('a primary worker sender must not carry a replica read endpoint');
  }
  return {
    kind,
    sink: sinkRecord,
    cards: {
      read_database: cards.readDatabase,
      ...(cards.readEndpoint ? { read_endpoint: cards.readEndpoint } : {}),
      cache: {
        enabled: cards.cache.enabled,
        fresh_ms: cards.cache.freshMs,
        stale_ms: cards.cache.staleMs,
        max_entries: cards.cache.maxEntries,
      },
    },
  };
}
