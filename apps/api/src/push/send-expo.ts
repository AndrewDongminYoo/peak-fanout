import { Expo } from 'expo-server-sdk';

import { REMINDER_MESSAGE } from '../scheduler/tick';
import { createExpoPushSink } from './expo';
import type { PushSink } from './sink';

type SinkFactory = (accessToken?: string) => PushSink;

function createSink(accessToken?: string): PushSink {
  return createExpoPushSink(new Expo(accessToken ? { accessToken } : undefined));
}

export async function runExpoSend(
  env: Record<string, string | undefined>,
  sinkFactory: SinkFactory = createSink,
  log: (line: string) => void = console.log,
): Promise<void> {
  const token = env.EXPO_PUSH_TOKEN;
  if (!token) throw new Error('EXPO_PUSH_TOKEN is required');

  const sink = sinkFactory(env.EXPO_ACCESS_TOKEN || undefined);
  const { latencyMs } = await sink.send(token, REMINDER_MESSAGE);
  log(`Expo accepted one push request in ${latencyMs}ms`);
}

if (import.meta.main) {
  try {
    await runExpoSend(process.env);
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  }
}
