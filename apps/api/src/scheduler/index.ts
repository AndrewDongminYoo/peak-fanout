// The scheduler process: `bun run dev:scheduler`.
//
// It never runs inside the API server process. The measurement is what a fan-out does to an API
// that is serving requests at the same time, and that is not observable when one process does
// both (design.md "The scheduler").

import { createDb } from '@peak-fanout/db';

import { requireEnv } from '../index';
import { createSimulatedPushSink, readSimulatedSinkConfig } from '../push/simulated';
import { createDrizzleRemindersRepository } from './reminders-drizzle';
import { readSchedulerConfig, startScheduler } from './runner';
import { runTick } from './tick';

if (import.meta.main) {
  const { intervalMs, now } = readSchedulerConfig(process.env);
  const sinkConfig = readSimulatedSinkConfig(process.env);
  const reminders = createDrizzleRemindersRepository(
    createDb(requireEnv('DATABASE_URL', process.env)),
  );
  const sink = createSimulatedPushSink(sinkConfig);

  console.log(
    `scheduler every ${intervalMs}ms, simulated sink ${sinkConfig.minLatencyMs}-${sinkConfig.maxLatencyMs}ms ` +
      `at failure rate ${sinkConfig.failureRate}, now=${now ? now.toISOString() : 'wall clock'}`,
  );
  startScheduler({
    tick: () => runTick({ reminders, sink, now: now ?? new Date() }),
    intervalMs,
  });
}
