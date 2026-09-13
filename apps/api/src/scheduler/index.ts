// The scheduler process: `bun run dev:scheduler`.
//
// It never runs inside the API server process. The measurement is what a fan-out does to an API
// that is serving requests at the same time, and that is not observable when one process does
// both (design.md "The scheduler").
//
// `SCHEDULER_MODE` picks the tick: `enqueue` (the default) inserts jobs for the workers in
// `../worker/` to send; `naive` is the M1 inline send, kept so the M1 row stays reproducible.

import { createDb } from '@peak-fanout/db';

import { requireEnv } from '../index';
import { describeSender } from '../push/sender';
import { createSimulatedPushSink, readSimulatedSinkConfig } from '../push/simulated';
import { enqueueTick } from './enqueue';
import { createDrizzleRemindersRepository } from './reminders-drizzle';
import { readSchedulerConfig, startScheduler, type TickOutcome } from './runner';
import { runTick } from './tick';

if (import.meta.main) {
  const { intervalMs, now, mode } = readSchedulerConfig(process.env);
  const db = createDb(requireEnv('DATABASE_URL', process.env));
  const currentTime = () => now ?? new Date();

  let tick: () => Promise<TickOutcome>;
  let sinkLine = '';
  if (mode === 'naive') {
    // Only the naive tick sends, so only it reads the sink's parameters; the enqueue tick's
    // sends happen in the workers, which read them there. The record built from those parameters
    // goes on every `deliveries` row this process writes, so the run log grades what a send was
    // made with and not only what it cost (design.md "The push sink").
    const sinkConfig = readSimulatedSinkConfig(process.env);
    const sink = createSimulatedPushSink(sinkConfig);
    const reminders = createDrizzleRemindersRepository(db, describeSender('naive', sinkConfig));
    sinkLine =
      `, simulated sink ${sinkConfig.minLatencyMs}-${sinkConfig.maxLatencyMs}ms ` +
      `at failure rate ${sinkConfig.failureRate}`;
    tick = () => runTick({ reminders, sink, now: currentTime() });
  } else {
    const reminders = createDrizzleRemindersRepository(db);
    tick = () => enqueueTick({ reminders, now: currentTime() });
  }

  console.log(
    `scheduler mode=${mode} every ${intervalMs}ms${sinkLine}, ` +
      `now=${now ? now.toISOString() : 'wall clock'}`,
  );
  startScheduler({ tick, intervalMs });
}
