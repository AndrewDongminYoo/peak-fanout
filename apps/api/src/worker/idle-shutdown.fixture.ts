// A process `loop.test.ts` spawns and watches exit. Not a test file, so `bun test` does not
// collect it; `bun <this file> <pollMs>` runs it.
//
// It runs `runWorkerLoop` over a queue that is always empty, with the process's own
// `sleepUnlessStopped` and a long poll, requests shutdown a few milliseconds into the first idle
// sleep, prints when the loop returned, and then does nothing more — as `index.ts` does nothing
// more after its shutdown line than close the database client. Whether the process exits then or
// only when the poll timer would have fired is the property under test, and it is observable only
// from outside the process: a test that awaits the loop's promise sees it settle at the same
// instant either way.

import { runWorkerLoop, sleepUnlessStopped, WORKER_DEFAULTS, type JobsRepository } from './loop';

const pollMs = Number(process.argv[2]);
if (!Number.isInteger(pollMs) || pollMs <= 0) {
  throw new Error(`usage: bun idle-shutdown.fixture.ts <pollMs>, got "${process.argv[2]}"`);
}
const abortAfterMs = 20;

const startedAt = performance.now();
const shutdown = new AbortController();
const stamp = (label: string) =>
  console.log(`${label}_ms=${Math.round(performance.now() - startedAt)}`);

let claims = 0;
const jobs: JobsRepository = {
  async claim() {
    claims += 1;
    // The abort lands inside the sleep that follows the first empty claim: the wait it cuts
    // short is the one whose timer has to be released.
    if (claims === 1) setTimeout(() => shutdown.abort(), abortAfterMs);
    return [];
  },
  async complete() {
    throw new Error('nothing was claimed, so nothing is completed');
  },
  async retryOrDeadLetter() {
    throw new Error('nothing was claimed, so nothing fails');
  },
};

process.on('exit', () => stamp('process_exit'));

await runWorkerLoop({
  jobs,
  sink: {
    async send() {
      throw new Error('nothing was claimed, so nothing is sent');
    },
  },
  workerId: 'fixture:idle',
  config: { ...WORKER_DEFAULTS, pollMs },
  clock: () => performance.now(),
  sleep: sleepUnlessStopped,
  shutdown: shutdown.signal,
  log: () => {},
});
stamp('loop_returned');
