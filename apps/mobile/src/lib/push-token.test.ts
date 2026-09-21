import { describe, expect, it, jest } from 'bun:test';

import { createSerialLane } from './concurrency';
import {
  describePushTokenFailure,
  PUSH_TOKEN_WRITE_TIMEOUT_MS,
  registerPushToken,
  shouldRequestNotificationPermission,
  visiblePushTokenStatus,
  type PushTokenDeps,
  type SessionSnapshot,
} from './push-token';

/** The `GET /me` shape (design.md), which `PUT /me/push-token` returns with the token filled in. */
type Me = { timezone: string; reminder_time: string; push_token: string | null };

const ME: Me = { timezone: 'UTC', reminder_time: '21:00:00', push_token: null };
const TOKEN = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
const PROJECT_ID = 'de4c63ee-1cbf-4960-b040-07e2b6da3a54';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

/** The shape `toApiError` produces for a non-2xx response. */
const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** The bearer token the fake session hands out for a user, so a PUT's signer is readable from its token. */
const accessTokenFor = (userId: string) => `access-token-of-${userId}`;

/**
 * Fake expo-notifications, session and API: every dependency counts its
 * calls, the permission answer and the token outcome are scripted,
 * `sessionUsers` is the user id each successive session read returns (the
 * last one repeats; `undefined` is signed out), `sessionError` rejects the
 * `sessionErrorAt`-th read (1-based) instead, and `putPushToken` records
 * the token and the bearer it was signed with before answering the `GET /me`
 * shape with that token, or rejecting with `putError`.
 */
function createFakeDeps(
  options: {
    projectId?: string | undefined;
    userId?: string | undefined;
    sessionUsers?: (string | undefined)[];
    sessionError?: Error;
    sessionErrorAt?: 1 | 2;
    granted?: boolean;
    permissionError?: Error;
    tokenError?: Error;
    putError?: Error;
  } = {},
) {
  const {
    sessionUsers = [USER_A],
    sessionError,
    sessionErrorAt = 1,
    granted = true,
    permissionError,
    tokenError,
    putError,
  } = options;
  // An explicit `undefined` must reach the deps, so no destructuring default here.
  const projectId = 'projectId' in options ? options.projectId : PROJECT_ID;
  const userId = 'userId' in options ? options.userId : USER_A;
  let permissionCalls = 0;
  let sessionReads = 0;
  let tokenCalls = 0;
  const projectIds: string[] = [];
  const putCalls: { token: string; accessToken: string }[] = [];

  const deps: PushTokenDeps<Me> = {
    projectId,
    userId,
    async getSession() {
      const user = sessionUsers[Math.min(sessionReads, sessionUsers.length - 1)];
      sessionReads += 1;
      if (sessionError && sessionReads === sessionErrorAt) throw sessionError;
      return user === undefined ? undefined : { userId: user, accessToken: accessTokenFor(user) };
    },
    async getPermission() {
      permissionCalls += 1;
      if (permissionError) throw permissionError;
      return granted;
    },
    async getExpoPushToken(id) {
      tokenCalls += 1;
      projectIds.push(id);
      if (tokenError) throw tokenError;
      return TOKEN;
    },
    async putPushToken(token, accessToken) {
      putCalls.push({ token, accessToken });
      if (putError) throw putError;
      return { ...ME, push_token: token };
    },
  };

  return {
    deps,
    projectIds,
    putCalls,
    get permissionCalls() {
      return permissionCalls;
    },
    get sessionReads() {
      return sessionReads;
    },
    get tokenCalls() {
      return tokenCalls;
    },
  };
}

describe('registerPushToken', () => {
  it('asks for permission, fetches the token with the project id, PUTs it, and carries the body', async () => {
    const fake = createFakeDeps();
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: true,
      me: { ...ME, push_token: TOKEN },
    });
    expect(fake.permissionCalls).toBe(1);
    expect(fake.projectIds).toEqual([PROJECT_ID]);
    expect(fake.putCalls).toEqual([{ token: TOKEN, accessToken: accessTokenFor(USER_A) }]);
    expect(fake.sessionReads).toBe(2);
  });

  // A magic link for another account can complete while the permission
  // prompt or the token call is pending; a PUT signed by that session would
  // land on the other account's row, so the write is skipped.
  it('skips the PUT when the session user changed before it', async () => {
    const fake = createFakeDeps({ sessionUsers: [USER_B] });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'session_changed',
      message: 'signed-in user changed before the token was stored',
    });
    expect(fake.tokenCalls).toBe(1);
    expect(fake.putCalls).toEqual([]);
  });

  // The comparison and the request share one session read: a switch that
  // lands between them must not re-sign the PUT as the new account, which is
  // what the API client's own send-time session read would do.
  it('signs the PUT with the session it compared, even if the session changed by send time', async () => {
    const fake = createFakeDeps({ sessionUsers: [USER_A, USER_B] });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'session_changed',
      message: 'signed-in user changed after the token was stored',
    });
    expect(fake.putCalls).toEqual([{ token: TOKEN, accessToken: accessTokenFor(USER_A) }]);
    expect(fake.sessionReads).toBe(2);
  });

  // `supabase.auth.getSession()` reads `LargeSecureStore`, and neither it nor
  // auth-js catches a storage rejection; the flow must still return a result,
  // or the screen's `registering` status never clears.
  it('reports api with a null status and skips the PUT when the session read before it rejects', async () => {
    const fake = createFakeDeps({
      sessionError: new Error('Could not decrypt the item'),
      sessionErrorAt: 1,
    });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'api',
      status: null,
      message: 'Could not decrypt the item',
    });
    expect(fake.tokenCalls).toBe(1);
    expect(fake.putCalls).toEqual([]);
  });

  // The PUT already succeeded, but the user it should be cached under cannot
  // be confirmed, so the body is dropped like a session switch.
  it('drops the body as session_changed when the session read after the PUT rejects', async () => {
    const fake = createFakeDeps({
      sessionError: new Error('Could not decrypt the item'),
      sessionErrorAt: 2,
    });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'session_changed',
      message: 'could not confirm the signed-in user after the token was stored',
    });
    expect(fake.putCalls).toEqual([{ token: TOKEN, accessToken: accessTokenFor(USER_A) }]);
  });

  it('never PUTs without a starting user', async () => {
    const fake = createFakeDeps({ userId: undefined, sessionUsers: [undefined] });
    expect(await registerPushToken(fake.deps)).toMatchObject({
      ok: false,
      reason: 'session_changed',
    });
    expect(fake.putCalls).toEqual([]);
  });

  it('reports permission_denied without asking for a token or calling the API', async () => {
    const fake = createFakeDeps({ granted: false });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'permission_denied',
      message: 'notification permission denied',
    });
    expect(fake.tokenCalls).toBe(0);
    expect(fake.putCalls).toEqual([]);
  });

  // A build made before expo-notifications was added has no native module:
  // getPermissionsAsync throws an UnavailabilityError instead of answering.
  it('reports unsupported with the thrown message when the permission call throws', async () => {
    const fake = createFakeDeps({
      permissionError: new Error(
        'The method or property Notifications.getPermissionsAsync is not available on ios',
      ),
    });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'The method or property Notifications.getPermissionsAsync is not available on ios',
    });
    expect(fake.tokenCalls).toBe(0);
    expect(fake.putCalls).toEqual([]);
  });

  it('reports unsupported before any native call when the project id is missing', async () => {
    const fake = createFakeDeps({ projectId: undefined });
    const result = await registerPushToken(fake.deps);
    expect(result).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(fake.permissionCalls).toBe(0);
    expect(fake.tokenCalls).toBe(0);
    expect(fake.putCalls).toEqual([]);
  });

  // Expo Go, a simulator without APNs, or no credentials: expo-notifications
  // throws from getExpoPushTokenAsync, and the message rides along.
  it('reports unsupported with the thrown message when the token call throws', async () => {
    const fake = createFakeDeps({
      tokenError: new Error('Must use physical device for push notifications'),
    });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'unsupported',
      message: 'Must use physical device for push notifications',
    });
    expect(fake.putCalls).toEqual([]);
  });

  it('reports api with the status and message when the PUT fails with an ApiError', async () => {
    const fake = createFakeDeps({
      putError: apiError(422, 'validation (invalid_push_token)'),
    });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'api',
      status: 422,
      message: 'validation (invalid_push_token)',
    });
    expect(fake.putCalls).toEqual([{ token: TOKEN, accessToken: accessTokenFor(USER_A) }]);
  });

  it('reports api with a null status when the request itself fails', async () => {
    const fake = createFakeDeps({ putError: new TypeError('Network request failed') });
    expect(await registerPushToken(fake.deps)).toEqual({
      ok: false,
      reason: 'api',
      status: null,
      message: 'Network request failed',
    });
  });
});

/** A promise settled by the test, so completion order is under control. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every pending microtask run so the flow reaches its next `await`; safe under fake timers, which hold `setTimeout` back. */
async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

// design.md "Me": the session read, the PUT and the read after it are one
// step in the lane the sign-out clear and the auth callback share. The fakes
// here hold a session the test can remove, the way sign-out does, and the
// other lane users are plain lane jobs that record when they ran.
describe('registerPushToken in the shared lane', () => {
  function createLaneDeps() {
    const lane = createSerialLane();
    const events: string[] = [];
    const put = deferred();
    const signals: AbortSignal[] = [];
    let stored: SessionSnapshot | undefined = {
      userId: USER_A,
      accessToken: accessTokenFor(USER_A),
    };
    let putAnswers = true;
    let tokenCalls = 0;
    let sessionReads = 0;
    /** Which session read (1-based) waits on which release; the event is recorded when the read answers. */
    let heldRead: { call: number; release: Promise<void> } | undefined;
    const deps: PushTokenDeps<Me> = {
      projectId: PROJECT_ID,
      userId: USER_A,
      async getSession() {
        sessionReads += 1;
        if (heldRead?.call === sessionReads) await heldRead.release;
        events.push(`session:${stored?.userId ?? 'none'}`);
        return stored;
      },
      getPermission: async () => true,
      async getExpoPushToken() {
        tokenCalls += 1;
        return TOKEN;
      },
      async putPushToken(token, _accessToken, signal) {
        signals.push(signal);
        events.push('put:start');
        if (!putAnswers) return new Promise<never>(() => undefined);
        await put.promise;
        events.push('put:end');
        return { ...ME, push_token: token };
      },
      runExclusive: lane,
    };
    return {
      deps,
      lane,
      events,
      put,
      signals,
      get tokenCalls() {
        return tokenCalls;
      },
      /** What sign-out does to the session, as a lane job the test releases. */
      signOutJob(release: Promise<void>) {
        return lane(async () => {
          events.push('signOut:start');
          await release;
          stored = undefined;
          events.push('signOut:end');
        });
      },
      neverAnswerPut() {
        putAnswers = false;
      },
      /** Hold the `call`-th session read (1 before the PUT, 2 after it) until the test releases it. */
      holdSessionRead(call: number) {
        const release = deferred();
        heldRead = { call, release: release.promise };
        return release;
      },
    };
  }

  it('lands a PUT already in flight before a clear queued behind it', async () => {
    const fake = createLaneDeps();

    const registration = registerPushToken(fake.deps);
    await flush();
    const clear = fake.lane(async () => {
      fake.events.push('clear');
    });
    await flush();
    expect(fake.events).toEqual([`session:${USER_A}`, 'put:start']);

    fake.put.resolve();
    expect(await registration).toEqual({ ok: true, me: { ...ME, push_token: TOKEN } });
    await clear;
    expect(fake.events).toEqual([
      `session:${USER_A}`,
      'put:start',
      'put:end',
      `session:${USER_A}`,
      'clear',
    ]);
  });

  it('skips the PUT when queued behind a sign-out, reading the session it left, while the token fetch ran outside the lane', async () => {
    const fake = createLaneDeps();
    const release = deferred();

    const signOut = fake.signOutJob(release.promise);
    const registration = registerPushToken(fake.deps);
    await flush();
    expect(fake.tokenCalls).toBe(1);
    expect(fake.events).toEqual(['signOut:start']);

    release.resolve();
    await signOut;
    expect(await registration).toEqual({
      ok: false,
      reason: 'session_changed',
      message: 'signed-in user changed before the token was stored',
    });
    expect(fake.events).toEqual(['signOut:start', 'signOut:end', 'session:none']);
  });

  it('abandons a PUT that never answers at the bound, aborts it, and lets the next lane step run', async () => {
    jest.useFakeTimers();
    try {
      const fake = createLaneDeps();
      fake.neverAnswerPut();

      const registration = registerPushToken(fake.deps);
      await flush();
      const clear = fake.lane(async () => {
        fake.events.push('clear');
      });
      await flush();
      expect(fake.events).toEqual([`session:${USER_A}`, 'put:start']);
      expect(fake.signals[0]?.aborted).toBe(false);

      jest.advanceTimersByTime(PUSH_TOKEN_WRITE_TIMEOUT_MS);
      expect(await registration).toEqual({
        ok: false,
        reason: 'api',
        status: null,
        message: `no answer within ${PUSH_TOKEN_WRITE_TIMEOUT_MS} ms`,
      });
      expect(fake.signals[0]?.aborted).toBe(true);
      await clear;
      expect(fake.events).toEqual([`session:${USER_A}`, 'put:start', 'clear']);
    } finally {
      jest.useRealTimers();
    }
  });

  // `supabase.auth.getSession()` refreshes an expired token over the network,
  // so the read before the PUT can stall as long as the PUT itself; the bound
  // covers the whole step, and a read that answers late must not send the
  // PUT the flow has already given up on.
  it('abandons the step when the session read before the PUT stalls, lets the next lane step run, and sends no PUT when the read answers late', async () => {
    jest.useFakeTimers();
    try {
      const fake = createLaneDeps();
      const read = fake.holdSessionRead(1);

      const registration = registerPushToken(fake.deps);
      await flush();
      const clear = fake.lane(async () => {
        fake.events.push('clear');
      });
      await flush();
      expect(fake.events).toEqual([]);

      jest.advanceTimersByTime(PUSH_TOKEN_WRITE_TIMEOUT_MS);
      expect(await registration).toEqual({
        ok: false,
        reason: 'api',
        status: null,
        message: `no answer within ${PUSH_TOKEN_WRITE_TIMEOUT_MS} ms`,
      });
      await clear;
      expect(fake.events).toEqual(['clear']);

      read.resolve();
      await flush();
      expect(fake.events).toEqual(['clear', `session:${USER_A}`]);
      expect(fake.signals).toEqual([]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports session_changed when the read after the PUT stalls past the bound, and lets the next lane step run', async () => {
    jest.useFakeTimers();
    try {
      const fake = createLaneDeps();
      fake.holdSessionRead(2);

      const registration = registerPushToken(fake.deps);
      await flush();
      const clear = fake.lane(async () => {
        fake.events.push('clear');
      });
      await flush();
      fake.put.resolve();
      await flush();
      expect(fake.events).toEqual([`session:${USER_A}`, 'put:start', 'put:end']);

      jest.advanceTimersByTime(PUSH_TOKEN_WRITE_TIMEOUT_MS);
      expect(await registration).toEqual({
        ok: false,
        reason: 'session_changed',
        message: 'could not confirm the signed-in user after the token was stored',
      });
      await clear;
      expect(fake.events).toEqual([`session:${USER_A}`, 'put:start', 'put:end', 'clear']);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('shouldRequestNotificationPermission', () => {
  it('asks while the platform still allows it, whatever the status says', () => {
    // iOS fresh install: undetermined. Android 13+ fresh install: the module
    // reports `denied` because notifications are not yet enabled, but the
    // POST_NOTIFICATIONS prompt has never been shown, so `canAskAgain` is true.
    expect(shouldRequestNotificationPermission({ granted: false, canAskAgain: true })).toBe(true);
  });

  it('does not ask again after a final denial', () => {
    expect(shouldRequestNotificationPermission({ granted: false, canAskAgain: false })).toBe(false);
  });

  it('does not ask when already granted', () => {
    expect(shouldRequestNotificationPermission({ granted: true, canAskAgain: true })).toBe(false);
    expect(shouldRequestNotificationPermission({ granted: true, canAskAgain: false })).toBe(false);
  });
});

describe('visiblePushTokenStatus', () => {
  const error = {
    kind: 'error',
    message: 'Notifications are off for this app in Settings',
  } as const;
  const registering = { kind: 'registering' } as const;

  it("renders the attempt's status while the signed-in user is the one who pressed the button", () => {
    expect(visiblePushTokenStatus({ userId: USER_A, status: error }, USER_A)).toEqual(error);
    expect(visiblePushTokenStatus({ userId: USER_A, status: registering }, USER_A)).toEqual(
      registering,
    );
  });

  it('renders idle on another account: a finished error line and an in-flight spinner both stay with the user who pressed', () => {
    expect(visiblePushTokenStatus({ userId: USER_A, status: error }, USER_B)).toEqual({
      kind: 'idle',
    });
    expect(visiblePushTokenStatus({ userId: USER_A, status: registering }, USER_B)).toEqual({
      kind: 'idle',
    });
  });

  it('renders idle when there is no signed-in user, even for an attempt without one', () => {
    expect(visiblePushTokenStatus({ userId: USER_A, status: error }, undefined)).toEqual({
      kind: 'idle',
    });
    expect(visiblePushTokenStatus({ userId: undefined, status: error }, undefined)).toEqual({
      kind: 'idle',
    });
  });
});

describe('describePushTokenFailure', () => {
  it('names each failure the way design.md "Me" specifies', () => {
    expect(
      describePushTokenFailure({ ok: false, reason: 'permission_denied', message: 'denied' }),
    ).toBe('Notifications are off for this app in Settings');
    expect(
      describePushTokenFailure({ ok: false, reason: 'unsupported', message: 'simulator' }),
    ).toBe('Push tokens need a physical device and an EAS project id');
    expect(
      describePushTokenFailure({ ok: false, reason: 'api', status: 404, message: 'not_found' }),
    ).toBe('PUT /me/push-token returned 404: not_found');
    expect(
      describePushTokenFailure({
        ok: false,
        reason: 'api',
        status: null,
        message: 'Network request failed',
      }),
    ).toBe('Network request failed');
  });
});
