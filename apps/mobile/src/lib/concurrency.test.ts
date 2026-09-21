import { describe, expect, it } from 'bun:test';

import { createSerialLane, withTimeout } from './concurrency';

/** A promise settled by the test, so completion order is under control. */
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every pending microtask run so a job reaches its next `await`. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('createSerialLane', () => {
  it('starts the next job only after the previous one settled, in call order', async () => {
    const run = createSerialLane();
    const events: string[] = [];
    const first = deferred();

    const a = run(async () => {
      events.push('a:start');
      await first.promise;
      events.push('a:end');
      return 'a';
    });
    const b = run(async () => {
      events.push('b');
      return 'b';
    });
    await settle();
    expect(events).toEqual(['a:start']);

    first.resolve();
    expect(await a).toBe('a');
    expect(await b).toBe('b');
    expect(events).toEqual(['a:start', 'a:end', 'b']);
  });

  it('hands each job its own outcome and lets the next run after a rejection', async () => {
    const run = createSerialLane();

    const failed = run(async () => {
      throw new Error('boom');
    });
    const next = run(async () => 'ok');

    await expect(failed).rejects.toThrow('boom');
    expect(await next).toBe('ok');
  });
});

describe('withTimeout', () => {
  it('resolves with the job when it answers in time, and leaves the signal alone', async () => {
    let seen: AbortSignal | undefined;

    expect(
      await withTimeout(50, async (signal) => {
        seen = signal;
        return 'done';
      }),
    ).toBe('done');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(seen?.aborted).toBe(false);
  });

  it('rejects the job’s own error', async () => {
    await expect(
      withTimeout(50, async () => {
        throw new Error('refused');
      }),
    ).rejects.toThrow('refused');
  });

  it('rejects at the bound and aborts the signal, even when the job never settles', async () => {
    let seen: AbortSignal | undefined;

    await expect(
      withTimeout(10, (signal) => {
        seen = signal;
        return new Promise<never>(() => undefined);
      }),
    ).rejects.toThrow('no answer within 10 ms');
    expect(seen?.aborted).toBe(true);
  });
});
