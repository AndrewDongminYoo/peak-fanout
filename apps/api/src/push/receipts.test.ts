import { describe, expect, it } from 'bun:test';

import {
  pollReceiptBatch,
  readReceiptConfig,
  runReceiptLoop,
  RECEIPT_DEFAULTS,
  type ClaimedReceipt,
  type ReceiptUpdate,
  type ReceiptsRepository,
} from './receipts';

const NOW = new Date('2026-10-04T12:00:00Z');
function receipt(id: string, overrides: Partial<ClaimedReceipt> = {}): ClaimedReceipt {
  return {
    deliveryId: id,
    ticketId: id,
    attempts: 1,
    acceptedAt: new Date(NOW.getTime() - 900_000),
    ...overrides,
  };
}
function setup(rows: ClaimedReceipt[]) {
  const updates: { row: ClaimedReceipt; update: ReceiptUpdate }[] = [];
  const repository: ReceiptsRepository = {
    async claim(limit) {
      return rows.slice(0, limit);
    },
    async finish(row, update) {
      updates.push({ row, update });
    },
  };
  return { repository, updates };
}

describe('Expo receipt polling', () => {
  it('requires explicit Expo selection', () => {
    for (const PUSH_SINK of [undefined, '', 'simulated', 'bad']) {
      expect(() => readReceiptConfig({ PUSH_SINK })).toThrow('PUSH_SINK=expo');
    }
    expect(readReceiptConfig({ PUSH_SINK: 'expo' })).toEqual(RECEIPT_DEFAULTS);
  });

  it('records provider status/error codes, missing and malformed receipts independently', async () => {
    const { repository, updates } = setup(
      ['ok', 'gone', 'other', 'missing', 'malformed'].map((id) => receipt(id)),
    );
    await pollReceiptBatch({
      repository,
      now: () => NOW,
      client: {
        async getPushNotificationReceiptsAsync(ids) {
          expect(ids).toEqual(['ok', 'gone', 'other', 'missing', 'malformed']);
          return {
            ok: { status: 'ok' },
            gone: {
              status: 'error',
              message: 'Device is gone',
              details: { error: 'DeviceNotRegistered' },
            },
            other: {
              status: 'error',
              message: 'Payload too large',
              details: { error: 'MessageTooBig' },
            },
            malformed: { status: 'unexpected' },
          };
        },
      },
    });
    expect(
      updates.map(({ update }) => [update.status, update.errorCode, update.lastError]),
    ).toEqual([
      ['ok', null, null],
      ['error', 'DeviceNotRegistered', null],
      ['error', 'MessageTooBig', null],
      ['pending', null, 'ReceiptMissing'],
      ['pending', null, 'ReceiptMalformed'],
    ]);
    expect(updates[3]?.update.nextCheckAt).toEqual(new Date(NOW.getTime() + 60_000));
  });

  it('bounds missing/transport retries and expires old or crash-exhausted work before calling Expo', async () => {
    const { repository, updates } = setup([
      receipt('old', { acceptedAt: new Date(NOW.getTime() - 86_400_000) }),
      receipt('crashed', { attempts: 9 }),
      receipt('last', { attempts: 8 }),
    ]);
    const calls: string[][] = [];
    await pollReceiptBatch({
      repository,
      now: () => NOW,
      client: {
        async getPushNotificationReceiptsAsync(ids) {
          calls.push(ids);
          throw new Error('secret token');
        },
      },
    });
    expect(calls).toEqual([['last']]);
    expect(updates.map(({ update }) => update.status)).toEqual(['expired', 'expired', 'expired']);
    expect(JSON.stringify(updates)).not.toContain('secret token');
  });

  it('chunks SDK lookups and continues after a transport failure', async () => {
    const { repository, updates } = setup(['a', 'b', 'c'].map((id) => receipt(id)));
    const calls: string[][] = [];
    await pollReceiptBatch({
      repository,
      now: () => NOW,
      chunkSize: 2,
      client: {
        async getPushNotificationReceiptsAsync(ids) {
          calls.push(ids);
          if (ids[0] === 'a') throw new Error('network');
          return { c: { status: 'ok' } };
        },
      },
    });
    expect(calls).toEqual([['a', 'b'], ['c']]);
    expect(updates.map(({ update }) => update.status)).toEqual(['pending', 'pending', 'ok']);
  });

  it('does not convert a persistence failure into a provider failure and settles the batch', async () => {
    let finishes = 0;
    const repository: ReceiptsRepository = {
      async claim() {
        return [receipt('a'), receipt('b')];
      },
      async finish() {
        finishes++;
        if (finishes === 1) throw new Error('database');
      },
    };
    await expect(
      pollReceiptBatch({
        repository,
        now: () => NOW,
        client: {
          async getPushNotificationReceiptsAsync() {
            return { a: { status: 'ok' }, b: { status: 'ok' } };
          },
        },
      }),
    ).rejects.toThrow('database');
    expect(finishes).toBe(2);
  });
});

it('drains an active receipt batch on shutdown and interrupts the idle wait', async () => {
  const shutdown = new AbortController();
  const { repository, updates } = setup([receipt('drain')]);
  await runReceiptLoop({
    repository,
    now: () => NOW,
    shutdown: shutdown.signal,
    client: {
      async getPushNotificationReceiptsAsync() {
        shutdown.abort();
        return { drain: { status: 'ok' } };
      },
    },
    sleep: async () => {
      throw new Error('must not sleep after drained batch');
    },
    log: () => {},
  });
  expect(updates).toHaveLength(1);
  const idle = new AbortController();
  let sleeps = 0;
  await runReceiptLoop({
    repository: setup([]).repository,
    now: () => NOW,
    shutdown: idle.signal,
    client: {
      async getPushNotificationReceiptsAsync() {
        throw new Error('must not poll empty batch');
      },
    },
    sleep: async (ms, signal) => {
      expect(ms).toBe(60_000);
      expect(signal).toBe(idle.signal);
      sleeps++;
      idle.abort();
    },
    log: () => {},
  });
  expect(sleeps).toBe(1);
});

it('schedules retries no later than the 24-hour receipt deadline', async () => {
  const acceptedAt = new Date(NOW.getTime() - 86_340_000);
  const { repository, updates } = setup([receipt('near-expiry', { acceptedAt, attempts: 7 })]);
  await pollReceiptBatch({
    repository,
    now: () => NOW,
    client: {
      async getPushNotificationReceiptsAsync() {
        return {};
      },
    },
  });
  expect(updates[0]?.update.status).toBe('pending');
  expect(updates[0]?.update.nextCheckAt).toEqual(new Date(acceptedAt.getTime() + 86_400_000));
});

describe('error receipt validation', () => {
  const malformed = [
    { status: 'error' },
    { status: 'error', message: null },
    { status: 'error', message: 42 },
    { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ...[null, [], 'invalid', 42].map((details) => ({
      status: 'error',
      message: 'Failed',
      details,
    })),
    ...[null, 42].map((error) => ({ status: 'error', message: 'Failed', details: { error } })),
    {
      status: 'error',
      message: 'Failed',
      details: { error: 'DeviceNotRegistered', expoPushToken: 42 },
    },
  ];
  it.each(malformed)(
    'retries malformed error receipt %j without keeping an actionable error code',
    async (value) => {
      const { repository, updates } = setup([receipt('malformed')]);
      await pollReceiptBatch({
        repository,
        now: () => NOW,
        client: {
          async getPushNotificationReceiptsAsync() {
            return { malformed: value };
          },
        },
      });
      expect(updates[0]?.update).toMatchObject({
        status: 'pending',
        errorCode: null,
        lastError: 'ReceiptMalformed',
        nextCheckAt: new Date(NOW.getTime() + 60_000),
      });
    },
  );

  it('expires a malformed error only when the normal retry bound is reached', async () => {
    const { repository, updates } = setup([receipt('last', { attempts: 8 })]);
    await pollReceiptBatch({
      repository,
      now: () => NOW,
      client: {
        async getPushNotificationReceiptsAsync() {
          return { last: { status: 'error' } };
        },
      },
    });
    expect(updates[0]?.update).toMatchObject({
      status: 'expired',
      errorCode: null,
      lastError: 'ReceiptMalformed',
    });
  });

  it.each([
    'DeveloperError',
    'DeviceNotRegistered',
    'ExpoError',
    'InvalidCredentials',
    'MessageRateExceeded',
    'MessageTooBig',
    'ProviderError',
    'FutureProviderError',
  ])('retains a valid terminal %s error', async (code) => {
    const { repository, updates } = setup([receipt('valid')]);
    await pollReceiptBatch({
      repository,
      now: () => NOW,
      client: {
        async getPushNotificationReceiptsAsync() {
          return {
            valid: {
              status: 'error',
              message: 'Provider failure',
              details: { error: code, expoPushToken: 'private-token' },
            },
          };
        },
      },
    });
    expect(updates[0]?.update).toMatchObject({ status: 'error', errorCode: code, lastError: null });
    expect(JSON.stringify(updates)).not.toContain('private-token');
    expect(JSON.stringify(updates)).not.toContain('Provider failure');
  });

  it.each([
    undefined,
    {},
    { error: undefined, expoPushToken: undefined },
    { expoPushToken: 'private-token' },
  ])('accepts absent optional error fields in details %j', async (details) => {
    const { repository, updates } = setup([receipt('valid')]);
    await pollReceiptBatch({
      repository,
      now: () => NOW,
      client: {
        async getPushNotificationReceiptsAsync() {
          return { valid: { status: 'error', message: '', details } };
        },
      },
    });
    expect(updates[0]?.update).toMatchObject({ status: 'error', errorCode: null, lastError: null });
  });
});
