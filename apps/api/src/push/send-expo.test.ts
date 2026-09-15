import { describe, expect, it } from 'bun:test';

import type { PushSink } from './sink';
import { runExpoSend } from './send-expo';

const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';

describe('runExpoSend', () => {
  it('refuses a missing token before it creates a provider sink', async () => {
    let factories = 0;

    await expect(
      runExpoSend(
        {},
        () => {
          factories += 1;
          throw new Error('must not construct');
        },
        () => undefined,
      ),
    ).rejects.toThrow('EXPO_PUSH_TOKEN is required');
    expect(factories).toBe(0);
  });

  it('sends the normal reminder copy and logs only the accepted latency', async () => {
    const sends: unknown[] = [];
    const logs: string[] = [];
    const sink: PushSink = {
      async send(token, message) {
        sends.push({ token, message });
        return { latencyMs: 24 };
      },
    };

    await runExpoSend(
      { EXPO_PUSH_TOKEN: TOKEN, EXPO_ACCESS_TOKEN: 'secret-access-token' },
      (accessToken) => {
        expect(accessToken).toBe('secret-access-token');
        return sink;
      },
      (line) => logs.push(line),
    );

    expect(sends).toEqual([
      {
        token: TOKEN,
        message: {
          title: 'Three expressions are waiting',
          body: 'Two minutes tonight beats an hour on the weekend.',
        },
      },
    ]);
    expect(logs).toEqual(['Expo accepted one push request in 24ms']);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain('secret-access-token');
  });
});
