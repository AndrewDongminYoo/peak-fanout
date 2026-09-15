import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';

import { PushSendError, type PushSink } from './sink';
import {
  createSimulatedPushSink,
  readSimulatedSinkConfig,
  type SimulatedSinkConfig,
} from './simulated';

export type ExpoPushClient = {
  sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<ExpoPushTicket[]>;
};

export type ExpoSenderConfig = {
  kind: 'expo';
  accessTokenConfigured: boolean;
};

export type WorkerPushSinkConfig =
  | {
      kind: 'simulated';
      config: SimulatedSinkConfig;
      sender: SimulatedSinkConfig;
    }
  | {
      kind: 'expo';
      accessToken?: string;
      sender: ExpoSenderConfig;
    };

export function readWorkerPushSinkConfig(
  env: Record<string, string | undefined>,
): WorkerPushSinkConfig {
  const kind = env.PUSH_SINK || 'simulated';
  if (kind === 'simulated') {
    const config = readSimulatedSinkConfig(env);
    return { kind, config, sender: config };
  }
  if (kind !== 'expo') throw new Error('PUSH_SINK must be simulated or expo');

  const accessToken = env.EXPO_ACCESS_TOKEN || undefined;
  return {
    kind,
    ...(accessToken ? { accessToken } : {}),
    sender: { kind, accessTokenConfigured: accessToken !== undefined },
  };
}

function elapsedMs(startedAt: number, now: () => number): number {
  return Math.max(0, Math.round(now() - startedAt));
}

export function createExpoPushSink(
  client: ExpoPushClient,
  now: () => number = () => performance.now(),
): PushSink {
  return {
    async send(token, message) {
      if (!Expo.isExpoPushToken(token)) {
        throw new PushSendError('Expo push token is missing or invalid', 0);
      }

      const startedAt = now();
      let tickets: ExpoPushTicket[];
      try {
        tickets = await client.sendPushNotificationsAsync([
          { to: token, title: message.title, body: message.body },
        ]);
      } catch (cause) {
        throw new PushSendError('Expo push request failed', elapsedMs(startedAt, now), { cause });
      }

      const latencyMs = elapsedMs(startedAt, now);
      if (tickets.length !== 1) {
        throw new PushSendError(`Expo returned ${tickets.length} tickets for one push`, latencyMs);
      }

      const ticket = tickets[0];
      if (ticket?.status !== 'ok' && ticket?.status !== 'error') {
        throw new PushSendError('Expo returned a malformed push ticket', latencyMs);
      }
      if (ticket?.status === 'error') {
        const code = ticket.details?.error ? ` (${ticket.details.error})` : '';
        throw new PushSendError(`Expo rejected push${code}: ${ticket.message}`, latencyMs);
      }
      return { latencyMs };
    },
  };
}

export function createWorkerPushSink(config: WorkerPushSinkConfig): PushSink {
  if (config.kind === 'simulated') return createSimulatedPushSink(config.config);
  const client = new Expo(config.accessToken ? { accessToken: config.accessToken } : undefined);
  return createExpoPushSink(client);
}

export function describeWorkerPushSink(config: WorkerPushSinkConfig): string {
  if (config.kind === 'simulated') {
    return (
      `simulated sink ${config.config.minLatencyMs}-${config.config.maxLatencyMs}ms ` +
      `at failure rate ${config.config.failureRate}`
    );
  }
  return `Expo sink with push security ${config.accessToken ? 'enabled' : 'disabled'}`;
}
