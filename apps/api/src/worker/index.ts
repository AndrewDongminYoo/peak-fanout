// The worker process: `bun run dev:worker`, one per terminal, N of them.
//
// Nothing coordinates the workers but the claim statement (design.md "The worker"). Each one
// wires Drizzle and defaults to the unchanged simulated sink. M5 permits the Expo sink only when
// PUSH_SINK=expo explicitly selects it. The worker reads WORKER_* from the environment and stops
// claiming on SIGTERM or SIGINT, finishing the batch in flight first.
//
// Since M3 it reads the day's cards before every send, through the cards service over `db.read`
// and the cache CARDS_CACHE* configures; everything it writes goes to `db.write` (design.md
// "Data model", "The worker reads the cards").

import { hostname } from 'node:os';

import { createReadWriteDb, endReadWriteDb } from '@peak-fanout/db';

import { createCardsCache, describeCardsCache, readCardsCacheConfig } from '../cards/cache';
import { createDrizzleCardsRepository } from '../cards/cards-drizzle';
import { readDatabaseEndpoint, verifyReadReplica } from '../cards/read-database';
import { createCardsService } from '../cards/service';
import { requireEnv } from '../index';
import {
  createWorkerPushSink,
  describeWorkerPushSink,
  readWorkerPushSinkConfig,
} from '../push/expo';
import { describeSender } from '../push/sender';
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
  const sinkConfig = readWorkerPushSinkConfig(process.env);
  const cacheConfig = readCardsCacheConfig(process.env);
  // An empty DATABASE_READ_URL counts as unset, as `requireEnv` reads an empty value: reads then
  // share the primary's pool rather than opening a second one (design.md "Data model").
  const readUrl = process.env.DATABASE_READ_URL || undefined;
  const db = createReadWriteDb({
    writeUrl: requireEnv('DATABASE_URL', process.env),
    readUrl,
  });
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
      `${describeWorkerPushSink(sinkConfig)}, ${describeCardsCache(cacheConfig)}, ` +
      `reads ${db.read === db.write ? 'share the primary' : 'go to DATABASE_READ_URL'}`,
  );

  try {
    const readDatabase = db.read === db.write ? 'primary' : 'replica';
    if (readDatabase === 'replica') await verifyReadReplica(db.read.$client);
    const readEndpoint = readUrl ? readDatabaseEndpoint(readUrl) : undefined;
    const summary = await runWorkerLoop({
      // The record every `deliveries` row this worker writes carries: the sink settings it read,
      // so the run log grades what a send was made with and not only what it cost (design.md
      // "The push sink"). The sink module itself learns nothing.
      jobs: createDrizzleJobsRepository(
        db.write,
        describeSender('worker', sinkConfig.sender, {
          cache: cacheConfig,
          readDatabase,
          ...(readEndpoint ? { readEndpoint } : {}),
        }),
      ),
      cards: createCardsService({
        repository: createDrizzleCardsRepository(db.read),
        cache: createCardsCache(cacheConfig),
      }),
      sink: createWorkerPushSink(sinkConfig),
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
    await endReadWriteDb(db, { timeout: 5 });
  }
}
