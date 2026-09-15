import { describe, expect, it } from 'bun:test';

import { CARDS_CACHE_DEFAULTS } from '../cards/cache';
import { describeSender } from './sender';
import { SIMULATED_SINK_DEFAULTS } from './simulated';

describe('describeSender', () => {
  it('records the cache configuration and cards read database for a worker', () => {
    expect(
      describeSender('worker', SIMULATED_SINK_DEFAULTS, {
        cache: { ...CARDS_CACHE_DEFAULTS, enabled: false },
        readDatabase: 'primary',
      }),
    ).toEqual({
      kind: 'worker',
      sink: {
        kind: 'simulated',
        min_latency_ms: 50,
        max_latency_ms: 150,
        failure_rate: 0,
      },
      cards: {
        read_database: 'primary',
        cache: {
          enabled: false,
          fresh_ms: 60_000,
          stale_ms: 600_000,
          max_entries: 64,
        },
      },
    });
  });

  it('keeps worker-only cards settings out of a naive sender record', () => {
    expect(describeSender('naive', SIMULATED_SINK_DEFAULTS)).toEqual({
      kind: 'naive',
      sink: {
        kind: 'simulated',
        min_latency_ms: 50,
        max_latency_ms: 150,
        failure_rate: 0,
      },
    });
  });

  it('records an Expo worker sink without recording its access token', () => {
    const sender = describeSender(
      'worker',
      { kind: 'expo', accessTokenConfigured: true },
      {
        cache: CARDS_CACHE_DEFAULTS,
        readDatabase: 'primary',
      },
    );

    expect(sender.sink).toEqual({ kind: 'expo', access_token_configured: true });
    expect(JSON.stringify(sender)).not.toContain('secret-access-token');
  });

  it('requires a verified endpoint for a replica and records it', () => {
    expect(() =>
      describeSender('worker', SIMULATED_SINK_DEFAULTS, {
        cache: CARDS_CACHE_DEFAULTS,
        readDatabase: 'replica',
      }),
    ).toThrow('verified read endpoint');

    expect(
      describeSender('worker', SIMULATED_SINK_DEFAULTS, {
        cache: CARDS_CACHE_DEFAULTS,
        readDatabase: 'replica',
        readEndpoint: 'localhost:5433/peak',
      }).cards,
    ).toMatchObject({
      read_database: 'replica',
      read_endpoint: 'localhost:5433/peak',
    });
  });
});
