// The worker process: `bun run dev:worker`, one per terminal, N of them.
//
// Nothing coordinates the workers but the claim statement (design.md "The worker"). Each one
// wires Drizzle and the simulated sink — imported unchanged, because M2 may change how sends are
// scheduled and not what one send costs — reads WORKER_* from the environment, and stops claiming
// on SIGTERM or SIGINT, finishing the batch in flight first.

import { hostname } from 'node:os';

import { createDb } from '@peak-fanout/db';

import { requireEnv } from '../index';
import { createSimulatedPushSink, readSimulatedSinkConfig } from '../push/simulated';
import { createDrizzleJobsRepository } from './jobs-drizzle';
import {
  formatShutdownLine,
  installShutdownHandlers,
  readWorkerConfig,
  runWorkerLoop,
  sleepUnlessStopped,
} from './loop';

if (import.meta.main) {
  const config = readWorkerConfig(process.env);
  const sinkConfig = readSimulatedSinkConfig(process.env);
  const db = createDb(requireEnv('DATABASE_URL', process.env));
  const workerId = `${hostname()}:${process.pid}`;
  const log = (line: string) => console.log(`${new Date().toISOString()} ${workerId} ${line}`);

  // The first signal of either kind requests the graceful path and removes both handlers, so a
  // second signal of either kind falls through to the runtime's default and kills the process:
  // an operator who sends another wants out now.
  const shutdown = new AbortController();
  installShutdownHandlers(process, () => shutdown.abort(), log);

  log(
    `started batch=${config.batchSize} poll=${config.pollMs}ms lease=${config.leaseMs}ms ` +
      `max_attempts=${config.maxAttempts} backoff_base=${config.backoffBaseMs}ms, ` +
      `simulated sink ${sinkConfig.minLatencyMs}-${sinkConfig.maxLatencyMs}ms ` +
      `at failure rate ${sinkConfig.failureRate}`,
  );

  try {
    const summary = await runWorkerLoop({
      jobs: createDrizzleJobsRepository(db),
      sink: createSimulatedPushSink(sinkConfig),
      workerId,
      config,
      clock: () => performance.now(),
      sleep: sleepUnlessStopped,
      shutdown: shutdown.signal,
      log,
    });
    log(formatShutdownLine(summary));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}
