import { describe, expect, it } from 'bun:test';

import { PushSendError } from './sink';
import { createExpoPushSink, readWorkerPushSinkConfig, type ExpoPushClient } from './expo';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const MESSAGE = {
  title: 'Three expressions are waiting',
  body: 'Two minutes tonight beats an hour on the weekend.',
};

describe('readWorkerPushSinkConfig', () => {
  it('keeps the worker on the simulated sink unless Expo is explicitly selected', () => {
    expect(readWorkerPushSinkConfig({})).toMatchObject({ kind: 'simulated' });
    expect(readWorkerPushSinkConfig({ PUSH_SINK: '' })).toMatchObject({ kind: 'simulated' });
  });

  it('selects Expo and records only whether push security is configured', () => {
    expect(
      readWorkerPushSinkConfig({ PUSH_SINK: 'expo', EXPO_ACCESS_TOKEN: 'secret-access-token' }),
    ).toEqual({
      kind: 'expo',
      accessToken: 'secret-access-token',
      sender: { kind: 'expo', accessTokenConfigured: true },
    });
    expect(readWorkerPushSinkConfig({ PUSH_SINK: 'expo', EXPO_ACCESS_TOKEN: '' })).toEqual({
      kind: 'expo',
      sender: { kind: 'expo', accessTokenConfigured: false },
    });
  });

  it('rejects an unknown sink instead of silently using a provider or simulation', () => {
    expect(() => readWorkerPushSinkConfig({ PUSH_SINK: 'stdout' })).toThrow(
      'PUSH_SINK must be simulated or expo',
    );
  });
});

describe('createExpoPushSink', () => {
  it('sends one exact notification and returns the measured request latency', async () => {
    const messages: unknown[] = [];
    const client: ExpoPushClient = {
      async sendPushNotificationsAsync(value) {
        messages.push(value);
        return [{ status: 'ok', id: 'ticket-id' }];
      },
    };
    const times = [100, 132];
    const sink = createExpoPushSink(client, () => times.shift() ?? 132);

    await expect(sink.send(TOKEN, MESSAGE)).resolves.toEqual({ latencyMs: 32 });
    expect(messages).toEqual([[{ to: TOKEN, title: MESSAGE.title, body: MESSAGE.body }]]);
  });

  it('refuses a missing or malformed token before a client call', async () => {
    let calls = 0;
    const client: ExpoPushClient = {
      async sendPushNotificationsAsync() {
        calls += 1;
        return [{ status: 'ok', id: 'ticket-id' }];
      },
    };
    const sink = createExpoPushSink(client);

    for (const token of [null, 'not-an-expo-token']) {
      const failure = sink.send(token, MESSAGE).catch((error: unknown) => error);
      await expect(failure).resolves.toBeInstanceOf(PushSendError);
      await expect(failure).resolves.toMatchObject({ latencyMs: 0 });
    }
    expect(calls).toBe(0);
  });

  it('preserves elapsed time and the original cause when the client throws', async () => {
    const cause = new Error('connection reset');
    const client: ExpoPushClient = {
      async sendPushNotificationsAsync() {
        throw cause;
      },
    };
    const times = [40, 57];
    const failure = createExpoPushSink(client, () => times.shift() ?? 57)
      .send(TOKEN, MESSAGE)
      .catch((error: unknown) => error);

    await expect(failure).resolves.toMatchObject({
      name: 'PushSendError',
      message: 'Expo push request failed',
      latencyMs: 17,
      cause,
    });
  });

  it('turns an Expo error ticket into a timed send failure', async () => {
    const client: ExpoPushClient = {
      async sendPushNotificationsAsync() {
        return [
          {
            status: 'error',
            message: 'The recipient device is not registered.',
            details: { error: 'DeviceNotRegistered' },
          },
        ];
      },
    };
    const times = [80, 105];
    const failure = createExpoPushSink(client, () => times.shift() ?? 105)
      .send(TOKEN, MESSAGE)
      .catch((error: unknown) => error);

    await expect(failure).resolves.toMatchObject({
      name: 'PushSendError',
      message: 'Expo rejected push (DeviceNotRegistered): The recipient device is not registered.',
      latencyMs: 25,
    });
  });

  it('rejects a response that does not contain exactly one ticket', async () => {
    const responses = [
      [],
      [
        { status: 'ok' as const, id: 'one' },
        { status: 'ok' as const, id: 'two' },
      ],
    ];
    for (const tickets of responses) {
      const client: ExpoPushClient = {
        async sendPushNotificationsAsync() {
          return tickets;
        },
      };
      const times = [10, 13];
      const failure = createExpoPushSink(client, () => times.shift() ?? 13)
        .send(TOKEN, MESSAGE)
        .catch((error: unknown) => error);

      await expect(failure).resolves.toMatchObject({
        name: 'PushSendError',
        message: `Expo returned ${tickets.length} tickets for one push`,
        latencyMs: 3,
      });
    }
  });

  it('rejects a malformed single ticket instead of marking the job sent', async () => {
    const client = {
      async sendPushNotificationsAsync() {
        return [{ status: 'unexpected' }];
      },
    } as unknown as ExpoPushClient;
    const times = [20, 26];
    const failure = createExpoPushSink(client, () => times.shift() ?? 26)
      .send(TOKEN, MESSAGE)
      .catch((error: unknown) => error);

    await expect(failure).resolves.toMatchObject({
      name: 'PushSendError',
      message: 'Expo returned a malformed push ticket',
      latencyMs: 6,
    });
  });
});
