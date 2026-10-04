import { createDb } from '@peak-fanout/db';
import { Expo } from 'expo-server-sdk';

import { installShutdownHandlers, sleepUnlessStopped } from '../worker/loop';
import { readReceiptConfig, runReceiptLoop } from './receipts';
import { createDrizzleReceiptsRepository } from './receipts-drizzle';

export async function runExpoReceipts(env: Record<string, string | undefined>): Promise<void> {
  // Refuse before constructing either client. This command is never a local/CI gate.
  readReceiptConfig(env);
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const db = createDb(env.DATABASE_URL);
  const client = new Expo(
    env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : undefined,
  );
  const shutdown = new AbortController();
  installShutdownHandlers(process, () => shutdown.abort(), console.log);
  try {
    await runReceiptLoop({
      repository: createDrizzleReceiptsRepository(db),
      client,
      now: () => new Date(),
      shutdown: shutdown.signal,
      sleep: sleepUnlessStopped,
      log: console.log,
    });
  } finally {
    await db.$client.end();
  }
}

if (import.meta.main) {
  try {
    await runExpoReceipts(process.env);
  } catch {
    // Database/SDK exceptions can contain credentials; diagnostics in rows use fixed codes.
    console.error(
      'Expo receipt poller failed; check PUSH_SINK=expo and primary database configuration',
    );
    process.exitCode = 1;
  }
}
