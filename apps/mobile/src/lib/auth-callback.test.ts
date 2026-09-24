import { describe, expect, it, jest } from 'bun:test';

import { createSerialLane } from './concurrency';
import { PUSH_TOKEN_WRITE_TIMEOUT_MS } from './push-token';
import {
  createSignInCompleter,
  fetchMeWithRecovery,
  shouldRetryMe,
  signOutWithFeedback,
  type SignInDeps,
} from './auth-callback';

const CALLBACK_URL = 'https://peak-fanout-links.vercel.app/auth/callback';
const FLOW_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FLOW_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const LINK_A = `${CALLBACK_URL}?sb_flow_id=${FLOW_A}&code=a`;
const LINK_B = `${CALLBACK_URL}?sb_flow_id=${FLOW_B}&code=b`;
const LINK_ERR = `${CALLBACK_URL}?error=access_denied&error_description=Email+link+is+invalid+or+has+expired`;

function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function createFakeDeps(stored?: { userId: string; accessToken: string }) {
  const events: string[] = [];
  const createUserCalls: ReturnType<typeof deferred>[] = [];
  const exchangeReleases: (() => void)[] = [];
  const signOutReleases: (() => void)[] = [];
  let exchangeError: Error | null = null;
  let clearError: Error | null = null;
  let sessionError: Error | null = null;
  let holdExchange = false;
  let holdSignOut = false;

  const deps: SignInDeps = {
    callbackUrl: CALLBACK_URL,
    async exchangeCode(code, flowId) {
      events.push(`exchange:${code}:${flowId}`);
      const error = exchangeError;
      if (holdExchange) {
        const call = deferred();
        exchangeReleases.push(call.resolve);
        await call.promise;
      }
      if (error) throw error;
      return { userId: code === 'b' ? 'user-b' : 'user-a' };
    },
    createUser() {
      events.push('createUser');
      const call = deferred();
      createUserCalls.push(call);
      return call.promise;
    },
    async signOutLocal() {
      events.push('signOutLocal');
      if (holdSignOut) {
        const call = deferred();
        signOutReleases.push(call.resolve);
        await call.promise;
      }
    },
    async getSession() {
      events.push('getSession');
      if (sessionError) throw sessionError;
      return stored;
    },
    async clearPushToken(accessToken) {
      events.push(`clear:${accessToken}`);
      if (clearError) throw clearError;
    },
  };

  return {
    deps,
    events,
    createUserCalls,
    exchangeReleases,
    signOutReleases,
    failExchange(error: Error) {
      exchangeError = error;
    },
    failClear(error: Error) {
      clearError = error;
    },
    failSession(error: Error) {
      sessionError = error;
    },
    holdExchange() {
      holdExchange = true;
    },
    holdSignOut() {
      holdSignOut = true;
    },
  };
}

describe('completeSignIn with PKCE', () => {
  it('exchanges a verified code, creates the app user, and leaves the session signed in', async () => {
    const fake = createFakeDeps();
    const completeSignIn = createSignInCompleter(fake.deps);
    const outcome = completeSignIn(LINK_A);
    await settle();
    expect(fake.events).toEqual([`getSession`, `exchange:a:${FLOW_A}`, 'createUser']);
    fake.createUserCalls[0]!.resolve();
    expect(await outcome).toBe('signed-in');
    expect(fake.events).not.toContain('signOutLocal');
  });

  it('rejects an error link immediately while a valid exchange is in flight', async () => {
    const fake = createFakeDeps();
    fake.holdExchange();
    const completeSignIn = createSignInCompleter(fake.deps);
    const outcome = completeSignIn(LINK_A);
    await settle();
    await expect(completeSignIn(LINK_ERR)).rejects.toThrow('Email link is invalid or has expired');
    expect(fake.events).toEqual(['getSession', `exchange:a:${FLOW_A}`]);
    fake.exchangeReleases[0]!();
    await settle();
    fake.createUserCalls[0]!.resolve();
    expect(await outcome).toBe('signed-in');
  });

  it('keeps the stored account and its push registration when code exchange fails', async () => {
    const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    fake.failExchange(new Error('PKCE code verifier not found'));
    await expect(createSignInCompleter(fake.deps)(LINK_B)).rejects.toThrow(
      'PKCE code verifier not found',
    );
    expect(fake.events).toEqual(['getSession', `exchange:b:${FLOW_B}`]);
  });

  it('runs two valid links in arrival order, including each app-user request', async () => {
    const fake = createFakeDeps();
    fake.holdExchange();
    const completeSignIn = createSignInCompleter(fake.deps);
    const first = completeSignIn(LINK_A);
    await settle();
    const second = completeSignIn(LINK_B);
    await settle();
    expect(fake.events).toEqual(['getSession', `exchange:a:${FLOW_A}`]);
    fake.exchangeReleases[0]!();
    await settle();
    expect(fake.createUserCalls).toHaveLength(1);
    fake.createUserCalls[0]!.resolve();
    expect(await first).toBe('signed-in');
    await settle();
    expect(fake.events).toContain(`exchange:b:${FLOW_B}`);
    fake.exchangeReleases[1]!();
    await settle();
    fake.createUserCalls[1]!.resolve();
    expect(await second).toBe('signed-in');
    expect(fake.events.filter((event) => event === 'createUser')).toHaveLength(2);
  });

  it('clears the previous account after exchange and before the app-user request', async () => {
    const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    const outcome = createSignInCompleter(fake.deps)(LINK_B);
    await settle();
    expect(fake.events).toEqual([
      'getSession',
      `exchange:b:${FLOW_B}`,
      'clear:old-a',
      'createUser',
    ]);
    fake.createUserCalls[0]!.resolve();
    expect(await outcome).toBe('signed-in');
  });

  it('keeps the registration when the verified user is the stored user', async () => {
    const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    const outcome = createSignInCompleter(fake.deps)(LINK_A);
    await settle();
    fake.createUserCalls[0]!.resolve();
    expect(await outcome).toBe('signed-in');
    expect(fake.events).toEqual(['getSession', `exchange:a:${FLOW_A}`, 'createUser']);
  });

  it('continues signing in if the old-account clear or session read fails', async () => {
    const clearFailed = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    clearFailed.failClear(new Error('clear failed'));
    const first = createSignInCompleter(clearFailed.deps)(LINK_B);
    await settle();
    clearFailed.createUserCalls[0]!.resolve();
    expect(await first).toBe('signed-in');
    expect(clearFailed.events).toContain('clear:old-a');

    const readFailed = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    readFailed.failSession(new Error('storage unavailable'));
    const second = createSignInCompleter(readFailed.deps)(LINK_B);
    await settle();
    readFailed.createUserCalls[0]!.resolve();
    expect(await second).toBe('signed-in');
    expect(readFailed.events).not.toContain('clear:old-a');
  });

  it('clears a kept same-user registration and signs out if app-user creation fails', async () => {
    const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    const outcome = createSignInCompleter(fake.deps)(LINK_A);
    await settle();
    fake.createUserCalls[0]!.reject(new Error('upsert failed'));
    await expect(outcome).rejects.toThrow('upsert failed');
    expect(fake.events).toEqual([
      'getSession',
      `exchange:a:${FLOW_A}`,
      'createUser',
      'clear:old-a',
      'signOutLocal',
    ]);
  });

  it('does not clear a switched account twice when app-user creation fails', async () => {
    const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    const outcome = createSignInCompleter(fake.deps)(LINK_B);
    await settle();
    fake.createUserCalls[0]!.reject(new Error('upsert failed'));
    await expect(outcome).rejects.toThrow('upsert failed');
    expect(fake.events).toEqual([
      'getSession',
      `exchange:b:${FLOW_B}`,
      'clear:old-a',
      'createUser',
      'signOutLocal',
    ]);
  });

  it('waits for a failed app-user attempt to sign out before exchanging the next code', async () => {
    const fake = createFakeDeps();
    fake.holdSignOut();
    const completeSignIn = createSignInCompleter(fake.deps);
    const first = completeSignIn(LINK_A);
    await settle();
    fake.createUserCalls[0]!.reject(new Error('upsert failed'));
    await settle();
    const second = completeSignIn(LINK_B);
    await settle();
    expect(fake.events).not.toContain(`exchange:b:${FLOW_B}`);
    fake.signOutReleases[0]!();
    await expect(first).rejects.toThrow('upsert failed');
    await settle();
    expect(fake.events).toContain(`exchange:b:${FLOW_B}`);
    fake.createUserCalls[1]!.resolve();
    expect(await second).toBe('signed-in');
  });

  it('orders a registration before the account switch and frees the lane before the app-user request finishes', async () => {
    const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
    const lane = createSerialLane();
    const completeSignIn = createSignInCompleter({ ...fake.deps, runExclusive: lane });
    const put = deferred();
    const registration = lane(async () => {
      fake.events.push('put:start');
      await put.promise;
      fake.events.push('put:end');
    });
    const outcome = completeSignIn(LINK_B);
    await settle();
    const later = lane(async () => {
      fake.events.push('later');
    });
    expect(fake.events).toEqual(['put:start']);
    put.resolve();
    await registration;
    await later;
    await settle();
    expect(fake.events).toEqual([
      'put:start',
      'put:end',
      'getSession',
      `exchange:b:${FLOW_B}`,
      'clear:old-a',
      'createUser',
      'later',
    ]);
    fake.createUserCalls[0]!.resolve();
    expect(await outcome).toBe('signed-in');
  });

  it('aborts a stalled old-account clear at the bound and still creates the app user', async () => {
    jest.useFakeTimers();
    try {
      const fake = createFakeDeps({ userId: 'user-a', accessToken: 'old-a' });
      const signals: AbortSignal[] = [];
      const completeSignIn = createSignInCompleter({
        ...fake.deps,
        clearPushToken(_accessToken, signal) {
          signals.push(signal);
          return new Promise<never>(() => undefined);
        },
      });
      const outcome = completeSignIn(LINK_B);
      await flush();
      expect(signals[0]?.aborted).toBe(false);
      jest.advanceTimersByTime(PUSH_TOKEN_WRITE_TIMEOUT_MS);
      await flush();
      expect(signals[0]?.aborted).toBe(true);
      fake.createUserCalls[0]!.resolve();
      expect(await outcome).toBe('signed-in');
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fetchMeWithRecovery', () => {
  const ME = { timezone: 'UTC', reminder_time: '21:00:00', push_tokens: [] };
  /** The shape `toApiError` produces for a non-2xx response. */
  const notFound = () => Object.assign(new Error('not_found'), { status: 404 });

  /**
   * `getMe` answers from `responses` in order; `createUser` counts calls and
   * rejects with `createUserError` when one is given.
   */
  function createFakeDeps(responses: (typeof ME | Error)[], createUserError?: Error) {
    let getMeCalls = 0;
    let createUserCalls = 0;
    return {
      deps: {
        async getMe() {
          getMeCalls += 1;
          const next = responses.shift();
          if (next instanceof Error) throw next;
          if (!next) throw new Error('getMe called more times than the test scripted');
          return next;
        },
        async createUser() {
          createUserCalls += 1;
          if (createUserError) throw createUserError;
        },
      },
      get getMeCalls() {
        return getMeCalls;
      },
      get createUserCalls() {
        return createUserCalls;
      },
    };
  }

  it('returns the row without touching POST /auth/session when GET /me succeeds', async () => {
    const fake = createFakeDeps([ME]);
    expect(await fetchMeWithRecovery(fake.deps)).toEqual(ME);
    expect(fake.createUserCalls).toBe(0);
  });

  // The window design.md names: the app died between code exchange and
  // POST /auth/session, so the restored session has no users row yet.
  it('upserts the user once and retries when GET /me answers 404', async () => {
    const fake = createFakeDeps([notFound(), ME]);
    expect(await fetchMeWithRecovery(fake.deps)).toEqual(ME);
    expect(fake.createUserCalls).toBe(1);
  });

  it('rejects with the second 404 after one upsert and one retry', async () => {
    const fake = createFakeDeps([notFound(), notFound()]);
    await expect(fetchMeWithRecovery(fake.deps)).rejects.toThrow('not_found');
    expect(fake.createUserCalls).toBe(1);
  });

  it('passes any other failure through without calling POST /auth/session', async () => {
    const fake = createFakeDeps([Object.assign(new Error('unauthorized'), { status: 401 })]);
    await expect(fetchMeWithRecovery(fake.deps)).rejects.toThrow('unauthorized');
    expect(fake.createUserCalls).toBe(0);
  });

  it('rejects with the upsert failure and does not retry GET /me', async () => {
    const fake = createFakeDeps([notFound(), ME], new Error('upsert failed'));
    await expect(fetchMeWithRecovery(fake.deps)).rejects.toThrow('upsert failed');
    expect(fake.getMeCalls).toBe(1);
    expect(fake.createUserCalls).toBe(1);
  });
});

describe('shouldRetryMe', () => {
  const notFound = Object.assign(new Error('not_found'), { status: 404 });

  // The helper already spent its one upsert and one retry on this 404; a
  // query retry would rerun both.
  it('never retries a 404, not even the first failure', () => {
    expect(shouldRetryMe(0, notFound)).toBe(false);
    expect(shouldRetryMe(1, notFound)).toBe(false);
  });

  it('keeps the default three retries for any other failure', () => {
    const unauthorized = Object.assign(new Error('unauthorized'), { status: 401 });
    expect(shouldRetryMe(0, unauthorized)).toBe(true);
    expect(shouldRetryMe(2, unauthorized)).toBe(true);
    expect(shouldRetryMe(3, unauthorized)).toBe(false);
    expect(shouldRetryMe(0, new TypeError('Network request failed'))).toBe(true);
  });
});

describe('signOutWithFeedback', () => {
  it('resolves null when sign-out succeeds', async () => {
    expect(await signOutWithFeedback({ signOut: async () => ({ error: null }) })).toBeNull();
  });

  // auth-js returns `{ error }` and keeps the stored session when the session
  // cannot be loaded before the sign-out request (expired token, no network).
  it('reports the returned error instead of dropping it', async () => {
    expect(
      await signOutWithFeedback({
        signOut: async () => ({ error: { message: 'Failed to fetch' } }),
      }),
    ).toBe('Failed to fetch');
  });

  it('reports a thrown failure as its message', async () => {
    expect(
      await signOutWithFeedback({
        signOut: async () => {
          throw new Error('storage unavailable');
        },
      }),
    ).toBe('storage unavailable');
  });

  it('clears the push token before signing out', async () => {
    const events: string[] = [];

    expect(
      await signOutWithFeedback({
        async clearPushToken() {
          events.push('clear');
        },
        async signOut() {
          events.push('signOut');
          return { error: null };
        },
      }),
    ).toBeNull();
    expect(events).toEqual(['clear', 'signOut']);
  });

  it('signs out anyway when the clear rejects, and says nothing about it', async () => {
    const events: string[] = [];

    expect(
      await signOutWithFeedback({
        async clearPushToken() {
          events.push('clear');
          throw new Error('unauthorized (expired_token)');
        },
        async signOut() {
          events.push('signOut');
          return { error: null };
        },
      }),
    ).toBeNull();
    expect(events).toEqual(['clear', 'signOut']);
  });

  it('still reports the sign-out error after a clear', async () => {
    let cleared = 0;

    expect(
      await signOutWithFeedback({
        async clearPushToken() {
          cleared += 1;
        },
        signOut: async () => ({ error: { message: 'Failed to fetch' } }),
      }),
    ).toBe('Failed to fetch');
    expect(cleared).toBe(1);
  });

  // design.md "Me": clear and sign-out are one lane step behind any
  // registration PUT already in flight, so the row ends cleared; a step
  // queued after them (a registration) runs only once the sign-out is done.
  it('waits for a registration PUT already in the lane, then clears and signs out as one step', async () => {
    const lane = createSerialLane();
    const events: string[] = [];
    const put = deferred();

    const registration = lane(async () => {
      events.push('put:start');
      await put.promise;
      events.push('put:end');
    });
    const outcome = signOutWithFeedback({
      async clearPushToken() {
        events.push('clear');
      },
      async signOut() {
        events.push('signOut');
        return { error: null };
      },
      runExclusive: lane,
    });
    const later = lane(async () => {
      events.push('later');
    });
    await settle();
    expect(events).toEqual(['put:start']);

    put.resolve();
    await registration;
    expect(await outcome).toBeNull();
    await later;
    expect(events).toEqual(['put:start', 'put:end', 'clear', 'signOut', 'later']);
  });

  it('signs out after the bound when the clear never answers, aborting it', async () => {
    jest.useFakeTimers();
    try {
      const events: string[] = [];
      const signals: AbortSignal[] = [];

      const outcome = signOutWithFeedback({
        clearPushToken(signal) {
          events.push('clear');
          signals.push(signal);
          return new Promise<never>(() => undefined);
        },
        async signOut() {
          events.push('signOut');
          return { error: null };
        },
      });
      await flush();
      expect(events).toEqual(['clear']);
      expect(signals[0]?.aborted).toBe(false);

      jest.advanceTimersByTime(PUSH_TOKEN_WRITE_TIMEOUT_MS);
      expect(await outcome).toBeNull();
      expect(signals[0]?.aborted).toBe(true);
      expect(events).toEqual(['clear', 'signOut']);
    } finally {
      jest.useRealTimers();
    }
  });
});
