/**
 * Run jobs one at a time in call order. `run(job)` resolves or rejects with
 * the job's own outcome, and a rejected job does not block the next one.
 */
export type SerialLane = <T>(job: () => Promise<T>) => Promise<T>;

/**
 * One FIFO lane. design.md "Me" and "Auth callback": the session-bound
 * push-token writes (registration's `PUT`, the sign-out clear, the magic-link
 * clear and the sign-in behind it) share one instance so that an earlier
 * write lands before a later one is sent, whichever finishes first on the
 * wire. A job that never settles would hold the lane forever, so every job
 * that waits on the network runs under `withTimeout`.
 */
export function createSerialLane(): SerialLane {
  /** The tail of the chain; kept settled-resolved so one failure does not block the next job. */
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const result = tail.then(job);
    tail = result.catch(() => undefined);
    return result;
  };
}

/**
 * Run `job` with an `AbortSignal` that fires after `ms`, and reject then
 * whether or not the job honours the signal: the race is the guarantee, the
 * abort is what frees the connection when `fetch` listens (RN's `whatwg-fetch`
 * and the browser both do). `AbortSignal.timeout` is not used because RN 0.86
 * still installs `abort-controller` 3.0.0, which predates it. The timer is
 * cleared once the job settles, so nothing lingers after a quick answer.
 */
export async function withTimeout<T>(
  ms: number,
  job: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`no answer within ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([job(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}
