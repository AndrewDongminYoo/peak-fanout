import { describe, expect, it, jest } from 'bun:test';

import { createSerialLane } from './concurrency';
import { PUSH_TOKEN_WRITE_TIMEOUT_MS } from './push-token';
import {
  createSignInCompleter,
  fetchMeWithRecovery,
  parseAuthCallback,
  readSubject,
  shouldRetryMe,
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

/** The same, without a timer, for tests that run under fake timers. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

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

/** An unsigned JWT-shaped token whose payload is `claims`, the way Supabase Auth names the user in `sub`. */
function fakeJwt(
  claims: unknown,
  payload = Buffer.from(JSON.stringify(claims)).toString('base64url'),
) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  return `${header}.${payload}.signature`;
}

describe('readSubject', () => {
  it('reads sub from a base64url payload without padding, without verifying the signature', () => {
    expect(readSubject(fakeJwt({ sub: 'user-a', email: 'a@example.com' }))).toBe('user-a');
  });

  it('decodes a UTF-8 payload, which Supabase writes when user metadata is not ASCII', () => {
    expect(readSubject(fakeJwt({ sub: 'user-a', user_metadata: { name: '민' } }))).toBe('user-a');
  });

  it('accepts a padded payload', () => {
    const payload = Buffer.from(JSON.stringify({ sub: 'user-a' })).toString('base64');
    expect(payload.endsWith('=')).toBe(true);
    expect(readSubject(fakeJwt(undefined, payload))).toBe('user-a');
  });

  it('is undefined for anything that is not a JWT with a string sub', () => {
    for (const token of [
      '',
      'a.access',
      'not-a-jwt',
      'header.',
      'header..signature',
      'header.%%%.signature',
      `header.${Buffer.from('{not json').toString('base64url')}.signature`,
      `header.${Buffer.from('"a string"').toString('base64url')}.signature`,
      `header.${Buffer.from('null').toString('base64url')}.signature`,
      fakeJwt({ email: 'a@example.com' }),
      fakeJwt({ sub: 42 }),
      fakeJwt({ sub: null }),
    ]) {
      expect(readSubject(token)).toBeUndefined();
    }
  });
});

describe('completeSignIn clears the previous account’s push token', () => {
  const TOKEN_A = fakeJwt({ sub: 'user-a' });
  const TOKEN_B = fakeJwt({ sub: 'user-b' });
  const LINK_FOR_B = `peakfanout://auth/callback#access_token=${TOKEN_B}&refresh_token=b.refresh`;
  const LINK_FOR_A = `peakfanout://auth/callback#access_token=${TOKEN_A}&refresh_token=a.refresh`;

  /** The base fakes plus a stored session and a clear that records what it was signed with, in call order. */
  function createSwitchingDeps(stored: { userId: string; accessToken: string } | undefined) {
    const fake = createFakeDeps();
    const events: string[] = [];
    let clearError: Error | null = null;
    let sessionError: Error | null = null;
    const deps: SignInDeps = {
      ...fake.deps,
      async setSession(tokens) {
        events.push(`setSession:${tokens.refresh_token}`);
        return fake.deps.setSession(tokens);
      },
      async getSession() {
        if (sessionError) throw sessionError;
        return stored;
      },
      async clearPushToken(accessToken) {
        events.push(`clear:${accessToken}`);
        if (clearError) throw clearError;
      },
    };
    return {
      fake,
      deps,
      events,
      failClear(error: Error) {
        clearError = error;
      },
      failSession(error: Error) {
        sessionError = error;
      },
    };
  }

  it('clears with the stored session’s token before setSession when the link names another user', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    const completeSignIn = createSignInCompleter(switching.deps);

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    switching.fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(switching.events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh']);
    expect(switching.fake.sessions).toEqual([TOKEN_B]);
  });

  it('keeps the registration when the link is for the same user', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: 'a.old-access' });
    const completeSignIn = createSignInCompleter(switching.deps);

    const outcome = completeSignIn(LINK_FOR_A);
    await settle();
    switching.fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(switching.events).toEqual(['setSession:a.refresh']);
  });

  it('does not clear when no session is stored', async () => {
    const switching = createSwitchingDeps(undefined);
    const completeSignIn = createSignInCompleter(switching.deps);

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    switching.fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(switching.events).toEqual(['setSession:b.refresh']);
  });

  it('does not clear when the link’s token has no readable subject', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    const completeSignIn = createSignInCompleter(switching.deps);

    const outcome = completeSignIn(LINK_B);
    await settle();
    switching.fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(switching.events).toEqual(['setSession:b.refresh']);
  });

  it('signs in anyway when the clear rejects', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    switching.failClear(new Error('unauthorized (expired_token)'));
    const completeSignIn = createSignInCompleter(switching.deps);

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    switching.fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(switching.events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh']);
    expect(switching.fake.signOutCalls).toBe(0);
  });

  it('signs in anyway when the stored session cannot be read', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    switching.failSession(new Error('storage unavailable'));
    const completeSignIn = createSignInCompleter(switching.deps);

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    switching.fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(switching.events).toEqual(['setSession:b.refresh']);
  });

  it('leaves the sign-in failure path as it was after a clear', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    switching.fake.failSetSession(new Error('invalid refresh token'));
    const completeSignIn = createSignInCompleter(switching.deps);

    await expect(completeSignIn(LINK_FOR_B)).rejects.toThrow('invalid refresh token');
    expect(switching.events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh']);
    expect(switching.fake.createUserCalls).toHaveLength(0);
    expect(switching.fake.signOutCalls).toBe(1);
  });

  /** `switching.deps` with `signOutLocal` recorded in `events`, so the clear's place around it is asserted. */
  function withSignOutEvents(switching: ReturnType<typeof createSwitchingDeps>): SignInDeps {
    return {
      ...switching.deps,
      async signOutLocal() {
        switching.events.push('signOutLocal');
        return switching.deps.signOutLocal();
      },
    };
  }

  // design.md "Auth callback": the same-user skip holds only while the
  // sign-in succeeds. A failed one drops the stored session, after which no
  // later link could clear that account's token, so the failure path clears
  // it with the access token read before setSession, then signs out.
  it('clears with the stored token, then signs out, when a same-user link’s setSession rejects', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: 'a.old-access' });
    switching.fake.failSetSession(new Error('otp_expired'));
    const completeSignIn = createSignInCompleter(withSignOutEvents(switching));

    await expect(completeSignIn(LINK_FOR_A)).rejects.toThrow('otp_expired');
    expect(switching.events).toEqual([
      'setSession:a.refresh',
      'clear:a.old-access',
      'signOutLocal',
    ]);
    expect(switching.fake.createUserCalls).toHaveLength(0);
  });

  it('clears with the stored token, then signs out, when a same-user link’s createUser fails', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: 'a.old-access' });
    const completeSignIn = createSignInCompleter(withSignOutEvents(switching));

    const outcome = completeSignIn(LINK_FOR_A);
    await settle();
    expect(switching.events).toEqual(['setSession:a.refresh']);
    switching.fake.createUserCalls[0]!.reject(new Error('unauthorized (bad signature)'));

    await expect(outcome).rejects.toThrow('unauthorized (bad signature)');
    expect(switching.events).toEqual([
      'setSession:a.refresh',
      'clear:a.old-access',
      'signOutLocal',
    ]);
  });

  it('still signs out and rethrows the sign-in error when the failure-path clear rejects', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: 'a.old-access' });
    switching.fake.failSetSession(new Error('otp_expired'));
    switching.failClear(new Error('unauthorized (expired_token)'));
    const completeSignIn = createSignInCompleter(withSignOutEvents(switching));

    await expect(completeSignIn(LINK_FOR_A)).rejects.toThrow('otp_expired');
    expect(switching.events).toEqual([
      'setSession:a.refresh',
      'clear:a.old-access',
      'signOutLocal',
    ]);
  });

  it('does not clear on failure when no session was stored', async () => {
    const switching = createSwitchingDeps(undefined);
    switching.fake.failSetSession(new Error('otp_expired'));
    const completeSignIn = createSignInCompleter(withSignOutEvents(switching));

    await expect(completeSignIn(LINK_FOR_A)).rejects.toThrow('otp_expired');
    expect(switching.events).toEqual(['setSession:a.refresh', 'signOutLocal']);
  });

  // The skip for an unreadable subject leaves the stored account's token in
  // place the same way, and setSession rejects that link, so the failure path
  // clears it too.
  it('clears with the stored token on failure when the link’s token has no readable subject', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    switching.fake.failSetSession(new Error('invalid JWT'));
    const completeSignIn = createSignInCompleter(withSignOutEvents(switching));

    await expect(completeSignIn(LINK_B)).rejects.toThrow('invalid JWT');
    expect(switching.events).toEqual(['setSession:b.refresh', `clear:${TOKEN_A}`, 'signOutLocal']);
  });

  it('does not clear on failure when the pre-setSession clear already ran for another user', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    const completeSignIn = createSignInCompleter(withSignOutEvents(switching));

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    switching.fake.createUserCalls[0]!.reject(new Error('unauthorized (bad signature)'));

    await expect(outcome).rejects.toThrow('unauthorized (bad signature)');
    expect(switching.events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh', 'signOutLocal']);
  });

  // design.md "Auth callback": a failed step 2's clear and sign-out are one
  // lane step, so a registration queued behind them reads no session.
  it('clears and signs out as one lane step when createUser fails', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: 'a.old-access' });
    const lane = createSerialLane();
    const events = switching.events;
    const completeSignIn = createSignInCompleter({
      ...withSignOutEvents(switching),
      runExclusive: lane,
    });

    const outcome = completeSignIn(LINK_FOR_A);
    await settle();
    switching.fake.holdWrites();
    switching.fake.createUserCalls[0]!.reject(new Error('unauthorized (bad signature)'));
    await settle();
    // The sign-out is held open inside the lane; a step queued now waits for it.
    const later = lane(async () => {
      events.push('later');
    });
    await settle();
    expect(events).toEqual(['setSession:a.refresh', 'clear:a.old-access', 'signOutLocal']);

    switching.fake.signOutReleases[0]!();
    await expect(outcome).rejects.toThrow('unauthorized (bad signature)');
    await later;
    expect(events).toEqual(['setSession:a.refresh', 'clear:a.old-access', 'signOutLocal', 'later']);
  });

  it('runs without the optional deps, as the earlier flow did', async () => {
    const fake = createFakeDeps();
    const completeSignIn = createSignInCompleter(fake.deps);

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    fake.createUserCalls[0]!.resolve();

    expect(await outcome).toBe('signed-in');
    expect(fake.sessions).toEqual([TOKEN_B]);
  });

  // design.md "Auth callback": the link takes its turn in the lane the Me
  // screen's registration and sign-out use, so a PUT already in flight lands
  // before the link's clear, and a registration queued behind the link reads
  // the session the link left.
  it('waits for a registration PUT already in the shared lane before clearing, and releases the lane once its session is stored, before its POST answers', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    const lane = createSerialLane();
    const completeSignIn = createSignInCompleter({ ...switching.deps, runExclusive: lane });
    const put = deferred();

    const registration = lane(async () => {
      switching.events.push('put:start');
      await put.promise;
      switching.events.push('put:end');
    });
    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    // The link has queued behind the PUT; a lane step queued now comes after it.
    const later = lane(async () => {
      switching.events.push('later');
    });
    await settle();
    expect(switching.events).toEqual(['put:start']);

    put.resolve();
    await registration;
    await later;
    await settle();
    // The POST is open, and the lane has already moved on.
    expect(switching.fake.createUserCalls).toHaveLength(1);
    expect(switching.events).toEqual([
      'put:start',
      'put:end',
      `clear:${TOKEN_A}`,
      'setSession:b.refresh',
      'later',
    ]);

    switching.fake.createUserCalls[0]!.resolve();
    expect(await outcome).toBe('signed-in');
  });

  // The failed write's local sign-out stays inside the lane step, so a
  // registration queued behind the link reads no session rather than the one
  // auth-js left behind.
  it('signs out inside the lane step when setSession fails, before the next lane step runs', async () => {
    const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
    switching.fake.holdWrites();
    switching.fake.failSetSession(new Error('invalid refresh token'));
    const lane = createSerialLane();
    const events = switching.events;
    const completeSignIn = createSignInCompleter({
      ...switching.deps,
      async signOutLocal() {
        events.push('signOutLocal');
        return switching.deps.signOutLocal();
      },
      runExclusive: lane,
    });

    const outcome = completeSignIn(LINK_FOR_B);
    await settle();
    // The write is on the wire, inside the lane; a step queued now waits for it.
    const later = lane(async () => {
      events.push('later');
    });
    switching.fake.setSessionCalls[0]!.release();
    await settle();
    expect(events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh', 'signOutLocal']);
    switching.fake.signOutReleases[0]!();

    await expect(outcome).rejects.toThrow('invalid refresh token');
    await later;
    expect(events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh', 'signOutLocal', 'later']);
  });

  it('signs in after the bound when the clear never answers, aborting it and freeing the lane', async () => {
    jest.useFakeTimers();
    try {
      const switching = createSwitchingDeps({ userId: 'user-a', accessToken: TOKEN_A });
      const signals: AbortSignal[] = [];
      const completeSignIn = createSignInCompleter({
        ...switching.deps,
        clearPushToken(accessToken, signal) {
          switching.events.push(`clear:${accessToken}`);
          signals.push(signal);
          return new Promise<never>(() => undefined);
        },
      });

      const outcome = completeSignIn(LINK_FOR_B);
      await flush();
      expect(switching.events).toEqual([`clear:${TOKEN_A}`]);
      expect(signals[0]?.aborted).toBe(false);

      jest.advanceTimersByTime(PUSH_TOKEN_WRITE_TIMEOUT_MS);
      await flush();
      expect(signals[0]?.aborted).toBe(true);
      expect(switching.events).toEqual([`clear:${TOKEN_A}`, 'setSession:b.refresh']);
      switching.fake.createUserCalls[0]!.resolve();

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
