import { describe, expect, it } from 'bun:test';

import {
  createSignInCompleter,
  fetchMeWithRecovery,
  parseAuthCallback,
  signOutWithFeedback,
  type SignInDeps,
} from './auth-callback';

const LINK_A = 'peakfanout://auth/callback#access_token=a.access&refresh_token=a.refresh';
const LINK_B = 'peakfanout://auth/callback#access_token=b.access&refresh_token=b.refresh';
const LINK_ERR =
  'peakfanout://auth/callback#error=access_denied&error_description=Email+link+is+invalid+or+has+expired';

/** A promise settled by the test, so response ordering is under control. */
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Fake supabase-js and API: `setSession` records the token it persisted once
 * the write completes, `createUser` hands back one deferred per call so the
 * test decides which request settles first, and `signOutLocal` counts calls.
 * After `holdWrites()`, each `setSession` and `signOutLocal` call stays open
 * until the test releases it, the way the real client waits on the network
 * before it saves or removes the stored session. `failSetSession` applies to
 * calls that start after it, so one link's write can fail while an earlier
 * held write still succeeds.
 */
function createFakeDeps() {
  const sessions: string[] = [];
  const createUserCalls: ReturnType<typeof deferred>[] = [];
  const setSessionCalls: { token: string; release: () => void }[] = [];
  const signOutReleases: (() => void)[] = [];
  let signOutCalls = 0;
  let setSessionError: Error | null = null;
  let held = false;

  const deps: SignInDeps = {
    async setSession(tokens) {
      const error = setSessionError;
      if (held) {
        const call = deferred();
        setSessionCalls.push({ token: tokens.access_token, release: call.resolve });
        await call.promise;
      }
      if (!error) sessions.push(tokens.access_token);
      return { error };
    },
    createUser() {
      const call = deferred();
      createUserCalls.push(call);
      return call.promise;
    },
    async signOutLocal() {
      if (held) {
        const call = deferred();
        signOutReleases.push(call.resolve);
        await call.promise;
      }
      signOutCalls += 1;
    },
  };

  return {
    deps,
    /** Access tokens in the order their writes completed; the last one is what the device holds unless a sign-out followed. */
    sessions,
    createUserCalls,
    setSessionCalls,
    signOutReleases,
    get signOutCalls() {
      return signOutCalls;
    },
    failSetSession(error: Error) {
      setSessionError = error;
    },
    holdWrites() {
      held = true;
    },
  };
}

/** Let every pending microtask run so the flow reaches its next `await`. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('parseAuthCallback', () => {
  it('reads the tokens from the fragment', () => {
    expect(parseAuthCallback(LINK_A)).toEqual({
      kind: 'tokens',
      accessToken: 'a.access',
      refreshToken: 'a.refresh',
    });
  });

  it('reads the tokens from the query string when a mail client rewrote the hash', () => {
    expect(parseAuthCallback(LINK_A.replace('#', '?'))).toEqual({
      kind: 'tokens',
      accessToken: 'a.access',
      refreshToken: 'a.refresh',
    });
  });

  it('prefers error_description over error', () => {
    expect(
      parseAuthCallback(
        'peakfanout://auth/callback#error=otp_expired&error_description=Link+expired',
      ),
    ).toEqual({ kind: 'error', message: 'Link expired' });
  });

  it('reports a link without a session', () => {
    expect(parseAuthCallback('peakfanout://auth/callback')).toEqual({ kind: 'none' });
  });
});

describe('completeSignIn', () => {
  it('persists the session, creates the user, and reports signed-in', async () => {
    const fake = createFakeDeps();
    const completeSignIn = createSignInCompleter(fake.deps);

    const outcome = completeSignIn(LINK_A);
    await settle();
    expect(fake.sessions).toEqual(['a.access']);
    fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(fake.signOutCalls).toBe(0);
  });

  it('rejects a link carrying an error without touching the session', async () => {
    const fake = createFakeDeps();
    const completeSignIn = createSignInCompleter(fake.deps);

    await expect(
      completeSignIn('peakfanout://auth/callback#error_description=Link+expired'),
    ).rejects.toThrow('Link expired');
    await expect(completeSignIn('peakfanout://auth/callback')).rejects.toThrow(
      'does not contain a session',
    );
    expect(fake.sessions).toEqual([]);
    expect(fake.createUserCalls).toHaveLength(0);
    expect(fake.signOutCalls).toBe(0);
  });

  // supabase-js returns a setSession error without clearing a session an
  // earlier link stored (auth-js 2.116.0 `_setSession` → `_getUser(jwt)` only
  // removes the store on AuthSessionMissingError), so the flow drops it itself.
  it('rejects when setSession fails, drops any stored session, and does not call the API', async () => {
    const fake = createFakeDeps();
    fake.failSetSession(new Error('invalid refresh token'));
    const completeSignIn = createSignInCompleter(fake.deps);

    await expect(completeSignIn(LINK_A)).rejects.toThrow('invalid refresh token');
    expect(fake.createUserCalls).toHaveLength(0);
    expect(fake.signOutCalls).toBe(1);
  });

  it('drops the session and rethrows when the API refuses the only attempt', async () => {
    const fake = createFakeDeps();
    const completeSignIn = createSignInCompleter(fake.deps);

    const outcome = completeSignIn(LINK_A);
    await settle();
    fake.createUserCalls[0]!.reject(new Error('unauthorized (bad signature)'));

    await expect(outcome).rejects.toThrow('unauthorized (bad signature)');
    expect(fake.signOutCalls).toBe(1);
  });

  // supabase-js saves a session only after its network round-trip, so two
  // concurrent setSession calls would persist in response order. Attempts run
  // one at a time instead: B waits for A to finish, POST included, so the
  // older account's slower write cannot land on top of the newer one and no
  // persisted session is left without its users row.
  it('runs two valid links one at a time, each followed by its own POST, newest persisted last', async () => {
    const fake = createFakeDeps();
    fake.holdWrites();
    const completeSignIn = createSignInCompleter(fake.deps);

    const first = completeSignIn(LINK_A);
    await settle();
    // A's write is on the wire when B arrives.
    const second = completeSignIn(LINK_B);
    await settle();

    // B has not started; only A's write is out.
    expect(fake.setSessionCalls.map((call) => call.token)).toEqual(['a.access']);

    fake.setSessionCalls[0]!.release();
    await settle();
    // A goes on to POST /auth/session while B still waits.
    expect(fake.createUserCalls).toHaveLength(1);
    expect(fake.setSessionCalls).toHaveLength(1);

    fake.createUserCalls[0]!.resolve();
    expect(await first).toBe('signed-in');
    await settle();
    expect(fake.setSessionCalls.map((call) => call.token)).toEqual(['a.access', 'b.access']);

    fake.setSessionCalls[1]!.release();
    await settle();
    expect(fake.createUserCalls).toHaveLength(2);
    fake.createUserCalls[1]!.resolve();
    expect(await second).toBe('signed-in');

    expect(fake.sessions).toEqual(['a.access', 'b.access']);
    expect(fake.signOutCalls).toBe(0);
  });

  // The round-7 repro shape: a link that cannot write a session (expired, or
  // no tokens) rejects on its own and must not disturb a valid link whose
  // write is already on the wire — that link still finishes with its POST.
  it('lets an unusable link reject while an in-flight valid link completes with its POST', async () => {
    const fake = createFakeDeps();
    fake.holdWrites();
    const completeSignIn = createSignInCompleter(fake.deps);

    const first = completeSignIn(LINK_A);
    await settle();
    expect(fake.setSessionCalls.map((call) => call.token)).toEqual(['a.access']);
    await expect(completeSignIn(LINK_ERR)).rejects.toThrow('Email link is invalid or has expired');

    fake.setSessionCalls[0]!.release();
    await settle();
    expect(fake.createUserCalls).toHaveLength(1);
    fake.createUserCalls[0]!.resolve();
    expect(await first).toBe('signed-in');
    expect(fake.sessions).toEqual(['a.access']);
    expect(fake.signOutCalls).toBe(0);
  });

  // The hole the ownership model left open: A saved its session, B took
  // over, B's setSession failed, and nobody called POST /auth/session or
  // signed out — a persisted session with no users row. Sequential attempts
  // close it: A finishes with its POST before B starts, and B's failure drops
  // whatever the store holds, so the device ends with no session.
  it('keeps the invariant when a later link’s setSession fails after an earlier link signed in', async () => {
    const fake = createFakeDeps();
    fake.holdWrites();
    const completeSignIn = createSignInCompleter(fake.deps);

    const first = completeSignIn(LINK_A);
    await settle();
    const second = completeSignIn(LINK_B);
    // Only writes that start from here on fail; A's is already on the wire.
    fake.failSetSession(new Error('invalid JWT'));
    await settle();

    fake.setSessionCalls[0]!.release();
    await settle();
    // A's session is followed by its users-row call.
    expect(fake.createUserCalls).toHaveLength(1);
    fake.createUserCalls[0]!.resolve();
    expect(await first).toBe('signed-in');
    await settle();

    expect(fake.setSessionCalls.map((call) => call.token)).toEqual(['a.access', 'b.access']);
    fake.setSessionCalls[1]!.release();
    await settle();
    expect(fake.signOutReleases).toHaveLength(1);
    fake.signOutReleases[0]!();
    await expect(second).rejects.toThrow('invalid JWT');

    // Invariant: the one session that was persisted (A's) had createUser
    // called, and B's failure signed the device out, so nothing is left
    // behind without a users row.
    expect(fake.sessions).toEqual(['a.access']);
    expect(fake.createUserCalls).toHaveLength(1);
    expect(fake.signOutCalls).toBe(1);
  });

  it('waits for a failed link’s sign-out before persisting the next link', async () => {
    const fake = createFakeDeps();
    const completeSignIn = createSignInCompleter(fake.deps);

    const first = completeSignIn(LINK_A);
    await settle();
    fake.holdWrites();
    fake.createUserCalls[0]!.reject(new Error('unauthorized (bad signature)'));
    await settle();
    expect(fake.signOutReleases).toHaveLength(1);

    // The sign-out is still in flight when the next link arrives; its write
    // must queue behind the removal or the removal would wipe it.
    const second = completeSignIn(LINK_B);
    await settle();
    expect(fake.setSessionCalls).toHaveLength(0);

    fake.signOutReleases[0]!();
    await expect(first).rejects.toThrow('unauthorized (bad signature)');
    await settle();
    expect(fake.setSessionCalls.map((call) => call.token)).toEqual(['b.access']);

    fake.setSessionCalls[0]!.release();
    await settle();
    fake.createUserCalls[1]!.resolve();
    expect(await second).toBe('signed-in');
    expect(fake.signOutCalls).toBe(1);
    expect(fake.sessions).toEqual(['a.access', 'b.access']);
  });
});

describe('fetchMeWithRecovery', () => {
  const ME = { timezone: 'UTC', reminder_time: '21:00:00', push_token: null };
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

  // The window design.md names: the app died between setSession and
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
});
