import { withTimeout, type SerialLane } from '@/lib/concurrency';

/**
 * design.md "Me" and "Auth callback": how long a lane step around a
 * `PUT /me/push-token` or a `DELETE /me/push-token` (the session reads and
 * the remembered-token storage access it needs included) may go unanswered
 * before it is abandoned and the request aborted. Both run inside the shared
 * lane, so the bound is also the longest a stalled step can hold up the
 * sign-out or sign-in queued behind it.
 */
export const PUSH_TOKEN_WRITE_TIMEOUT_MS = 5_000;

/**
 * What push-token registration needs from `expo-notifications`,
 * `expo-constants`, the Supabase session and the API client. Injected so the
 * flow runs under `bun test` without the native modules behind it;
 * `index.tsx` supplies the real ones. `Me` is the `GET /me` body, which
 * `PUT /me/push-token` returns too.
 */
export type PushTokenDeps<Me> = {
  /** `Constants.expoConfig.extra.eas.projectId`; missing outside an EAS-configured build. */
  projectId: string | undefined;
  /** The signed-in user the registration started for; the token is stored only while the session still belongs to them. */
  userId: string | undefined;
  /** The current session, read around the `PUT` because a magic link can sign in another account mid-flow; `undefined` when signed out. May reject when the session storage fails. */
  getSession(): Promise<SessionSnapshot | undefined>;
  /** Whether notifications are allowed, asking while the system still lets the app ask (`shouldRequestNotificationPermission`). */
  getPermission(): Promise<boolean>;
  /** `getExpoPushTokenAsync({ projectId })`; rejects on a simulator, offline, or without credentials. */
  getExpoPushToken(projectId: string): Promise<string>;
  /**
   * `PUT /me/push-token`, signed with `accessToken` rather than whatever
   * session the API client would read at send time, and aborted through
   * `signal` once `PUSH_TOKEN_WRITE_TIMEOUT_MS` passes; rejects with the
   * `ApiError` from `toApiError`, or a plain error when the request itself fails.
   */
  putPushToken(token: string, accessToken: string, signal: AbortSignal): Promise<Me>;
  /**
   * Remember `token` as the push token this installation registered, once
   * the `PUT` answered 2xx, so the next clear can name it (design.md "Me":
   * one AsyncStorage key, not keyed by user, overwritten by the next
   * successful `PUT` and never removed; `sign-in.ts` supplies it). Best
   * effort: a rejection is ignored and changes nothing in the result.
   */
  rememberPushToken(token: string): Promise<void>;
  /**
   * The lane the session read, the `PUT` and the read after it run in as one
   * bounded step (`sign-in.ts` supplies the instance shared with sign-out and
   * the auth callback); absent, the step runs at once, as under a test of the
   * flow alone.
   */
  runExclusive?: SerialLane;
};

/** One read of the Supabase session: the user it belongs to and the bearer token that signs requests as them. */
export type SessionSnapshot = { userId: string; accessToken: string };

export type PushTokenFailure =
  | { ok: false; reason: 'permission_denied'; message: string }
  | { ok: false; reason: 'unsupported'; message: string }
  | { ok: false; reason: 'api'; status: number | null; message: string }
  | { ok: false; reason: 'session_changed'; message: string };

export type PushTokenResult<Me> = { ok: true; me: Me } | PushTokenFailure;

/** The two `expo-notifications` permission fields the request decision reads. */
export type NotificationPermissionState = { granted: boolean; canAskAgain: boolean };

/**
 * Whether `requestPermissionsAsync` should run. The status is not the test:
 * on Android 13+ a fresh install reports `status: 'denied'` with
 * `canAskAgain: true` (`NotificationPermissionsModule.kt` maps
 * `!areNotificationsEnabled()` to denied before undetermined), and iOS reports
 * `undetermined` there; both carry `canAskAgain: true`. A final denial is
 * `canAskAgain: false` on both platforms (iOS: `status != denied`; Android
 * pre-13: the notifications toggle), and only Settings can undo it.
 */
export function shouldRequestNotificationPermission(current: NotificationPermissionState) {
  return !current.granted && current.canAskAgain;
}

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Register this device for push: permission, then the Expo push token, then
 * `PUT /me/push-token`. Each step's failure is reported as a reason the
 * screen can name (design.md "Me"); nothing throws. A missing project id is
 * `unsupported` before any native call, because `getExpoPushTokenAsync`
 * cannot mint a token without one; a permission call that throws (the
 * native module is absent, as in a build made before `expo-notifications`
 * was added) or a token call that throws (simulator, no APNs credentials,
 * offline; on Android also no `googleServicesFile`, which is why the Me
 * screen gates the button to iOS until FCM is configured) is `unsupported`
 * with the thrown message; a failed
 * `PUT` is `api` with the response status when the API answered and `null`
 * when the request never completed. The session is read once just before the
 * `PUT`: its user is compared with `userId`, and its access token signs the
 * request. One snapshot serves both, because the API client's own
 * `headers()` re-reads the session at send time, and a magic link completing
 * between the comparison and that re-read would sign the `PUT` as the
 * switched account and overwrite its token. The session user is read again
 * after the `PUT` so the body is never cached under the previous user's key.
 * Between the two, once the `PUT` has answered, the token is handed to
 * `rememberPushToken`, whether or not that second read then confirms the
 * user: the installation registered it either way, and the clears in
 * `sign-in.ts` send it so they clear only a row still holding it.
 * Either mismatch is `session_changed`, which the screen drops without an
 * error line. A session read that rejects (`LargeSecureStore` behind
 * `supabase.auth.getSession()` throws through auth-js uncaught) is `api` with
 * a `null` status before the `PUT`, because the request could not be signed,
 * and `session_changed` after it, because the user to cache the body under
 * cannot be confirmed.
 *
 * The session read, the `PUT` and the read after it run as one step in
 * `runExclusive`, the lane shared with the sign-out clear and the auth
 * callback: a `PUT` that answered lands before a clear sent after it, so the
 * row ends cleared (design.md "Me" names the one exception, a `PUT`
 * abandoned at the bound that the server was still applying), and a
 * registration queued behind a clear or an account switch reads the session
 * they left and skips its `PUT` as `session_changed`. The permission prompt
 * and the token fetch stay outside the lane so an open dialog holds nothing
 * up. The whole step is abandoned after `PUSH_TOKEN_WRITE_TIMEOUT_MS`, so
 * the lane advances whichever of the three waits stalled: `api` with a
 * `null` status before the `PUT` answered, `session_changed` after it, as
 * for a read that rejects. A session read that resumes after the bound sends
 * no `PUT`, because the flow has already reported the timeout and the lane
 * may have moved on to a clear.
 */
export async function registerPushToken<Me>(deps: PushTokenDeps<Me>): Promise<PushTokenResult<Me>> {
  const { projectId } = deps;
  if (!projectId) {
    return { ok: false, reason: 'unsupported', message: 'no EAS project id in the app config' };
  }

  let granted: boolean;
  try {
    granted = await deps.getPermission();
  } catch (cause) {
    return { ok: false, reason: 'unsupported', message: errorMessage(cause) };
  }
  if (!granted) {
    return { ok: false, reason: 'permission_denied', message: 'notification permission denied' };
  }

  let token: string;
  try {
    token = await deps.getExpoPushToken(projectId);
  } catch (cause) {
    return { ok: false, reason: 'unsupported', message: errorMessage(cause) };
  }

  const runExclusive: SerialLane = deps.runExclusive ?? ((job) => job());
  return runExclusive(() => storePushToken(deps, token));
}

const UNCONFIRMED_AFTER_STORE: PushTokenFailure = {
  ok: false,
  reason: 'session_changed',
  message: 'could not confirm the signed-in user after the token was stored',
};

/**
 * The lane step of `registerPushToken`: session read, `PUT`, storage write,
 * session read, under one `PUSH_TOKEN_WRITE_TIMEOUT_MS`. Every wait inside
 * catches its own failure and returns a result, so the only rejection the
 * bound can produce is its own, mapped by whether the `PUT` had answered
 * when it fired.
 */
async function storePushToken<Me>(
  deps: PushTokenDeps<Me>,
  token: string,
): Promise<PushTokenResult<Me>> {
  const { userId } = deps;
  /** Set once the `PUT` answered; a bound that expires afterwards left the token stored but unconfirmed. */
  let stored = false;

  try {
    return await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, async (signal) => {
      let session: SessionSnapshot | undefined;
      try {
        session = await deps.getSession();
      } catch (cause) {
        return { ok: false, reason: 'api', status: null, message: errorMessage(cause) };
      }
      if (userId === undefined || session === undefined || session.userId !== userId) {
        return {
          ok: false,
          reason: 'session_changed',
          message: 'signed-in user changed before the token was stored',
        };
      }
      // A session read that answered only after the bound: the race has
      // already reported the timeout and the lane may be on a clear, so the
      // `PUT` must not go out now. This value is never the flow's result.
      if (signal.aborted) {
        return {
          ok: false,
          reason: 'api',
          status: null,
          message: 'abandoned before the token was sent',
        };
      }
      const { accessToken } = session;

      let me: Me;
      try {
        me = await deps.putPushToken(token, accessToken, signal);
      } catch (cause) {
        const status =
          typeof cause === 'object' &&
          cause !== null &&
          'status' in cause &&
          typeof cause.status === 'number'
            ? cause.status
            : null;
        return { ok: false, reason: 'api', status, message: errorMessage(cause) };
      }
      stored = true;
      // design.md "Me": remembered as soon as the server holds it, so a
      // clear after a failed confirmation below still names this token. A
      // write that fails leaves whatever was remembered before and changes
      // nothing here; a write that stalls is abandoned with the step.
      try {
        await deps.rememberPushToken(token);
      } catch {
        // Best effort; see above.
      }

      let sessionAfter: SessionSnapshot | undefined;
      try {
        sessionAfter = await deps.getSession();
      } catch {
        return UNCONFIRMED_AFTER_STORE;
      }
      if (sessionAfter?.userId !== userId) {
        return {
          ok: false,
          reason: 'session_changed',
          message: 'signed-in user changed after the token was stored',
        };
      }
      return { ok: true, me };
    });
  } catch (cause) {
    return stored
      ? UNCONFIRMED_AFTER_STORE
      : { ok: false, reason: 'api', status: null, message: errorMessage(cause) };
  }
}

/**
 * The body of a `DELETE /me/push-token` (design.md "DELETE /me/push-token"):
 * `{ token }` for the token this installation remembered at its last
 * successful registration, so exactly this installation's row is deleted,
 * and `undefined` (no body, which the server answers as a no-op) when
 * nothing is remembered or the read rejects, so a clear never fails for want
 * of storage and neither outcome shows on the screen. Never
 * `{ token: undefined }`, which would go out as `{}` and be refused with a
 * 422. The read is awaited here, inside the caller's bounded lane step, so a
 * stalled read abandons the step the way a stalled request does.
 */
export async function clearPushTokenBody(
  readRememberedPushToken: () => Promise<string | null | undefined>,
): Promise<{ token: string } | undefined> {
  try {
    const token = await readRememberedPushToken();
    return typeof token === 'string' && token !== '' ? { token } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * design.md "Me": whether the card's "This device" line reads registered. The
 * installation is registered when the token it remembered at its last
 * successful `PUT` (or learned through `reconcileRememberedPushToken`) is one
 * of the rows `GET /me` listed; nothing remembered, or a remembered token the
 * server no longer holds, is not registered, and the button then offers to
 * register rather than to refresh.
 */
export function isThisDeviceRegistered(
  pushTokens: readonly string[],
  remembered: string | null | undefined,
): boolean {
  return typeof remembered === 'string' && remembered !== '' && pushTokens.includes(remembered);
}

/**
 * What the reconcile needs (design.md "Me"). Injected like `PushTokenDeps`,
 * so the flow runs under `bun test` without the native modules; `index.tsx`
 * supplies the real ones.
 */
export type ReconcileDeps = {
  /** `Platform.OS === 'ios'`: the only platform that can hold a token today ("Me"). */
  isIos: boolean;
  /** `Constants.expoConfig.extra.eas.projectId`; without one no token can be read. */
  projectId: string | undefined;
  /** The `push_tokens` the loaded `GET /me` body listed for the signed-in user. */
  pushTokens: readonly string[];
  /** The AsyncStorage read behind `clearPushTokenBody`; `sign-in.ts` supplies it. */
  readRememberedPushToken(): Promise<string | null | undefined>;
  /** `getPermissionsAsync().granted`, a read that never prompts (`hasNotificationPermission`). */
  hasPermission(): Promise<boolean>;
  /** `getExpoPushTokenAsync({ projectId })`; rejects on a simulator, offline, or without credentials. */
  getExpoPushToken(projectId: string): Promise<string>;
  /** `rememberPushToken` from `sign-in.ts`; best effort, as in registration. */
  rememberPushToken(token: string): Promise<void>;
  /**
   * The lane registration's storage write runs in (`sign-in.ts` supplies the
   * instance shared with sign-out and the auth callback); the re-read and the
   * write of the learned token take one bounded step in it. Absent, the step
   * runs at once, as under a test of the flow alone.
   */
  runExclusive?: SerialLane;
};

/** The stored value as a token: `null` for nothing stored, an empty string or a non-string. */
function rememberedFrom(stored: string | null | undefined): string | null {
  return typeof stored === 'string' && stored !== '' ? stored : null;
}

/**
 * design.md "Me": whether the loaded card should run the reconcile for
 * `userId`, given the user (`reconciledFor`) the last run on this mount was
 * for. It runs at most once per signed-in account per mount: the card stays
 * mounted across a magic-link switch, so the account signed in after it gets
 * its own run against its own `push_tokens`, while a refetch for the same
 * account does not run it again; signed out, nothing runs.
 */
export function reconcileIsDue(
  reconciledFor: string | undefined,
  userId: string | undefined,
): boolean {
  return userId !== undefined && reconciledFor !== userId;
}

/**
 * The token this installation should treat as its own, or `null`: what the
 * storage remembers when it remembers one, and otherwise, on iOS with a
 * project id and permission already granted, the device's current Expo push
 * token when the server lists it, which is then remembered so the next clear
 * can name it (design.md "Me"). This is what makes the body-less `DELETE`'s
 * no-op safe: an installation that registered before the key existed, or
 * lost its storage, learns its own token again before its next sign-out.
 * No server call, no prompt (`hasPermission` only reads), every failure
 * silent; the screen runs it at most once per signed-in account per mount
 * (`reconcileIsDue`). A token the server does not list is not remembered,
 * because remembering it would make the next clear name a row that is not
 * there and the card claim a registration the server does not hold.
 *
 * The permission read and the token read stay outside the lane, like
 * registration's; the write goes through `rememberLearnedPushToken`, one
 * step in `runExclusive`, because registration's own write runs there and a
 * `PUT` that answered while the device token was being read here would
 * otherwise be overwritten by an older token the next clear would then name.
 */
export async function reconcileRememberedPushToken(deps: ReconcileDeps): Promise<string | null> {
  let remembered: string | null;
  try {
    remembered = rememberedFrom(await deps.readRememberedPushToken());
  } catch {
    return null;
  }
  if (remembered !== null) return remembered;
  if (!deps.isIos || deps.projectId === undefined) return null;

  let token: string;
  try {
    if (!(await deps.hasPermission())) return null;
    token = await deps.getExpoPushToken(deps.projectId);
  } catch {
    return null;
  }
  if (!deps.pushTokens.includes(token)) return null;

  const runExclusive: SerialLane = deps.runExclusive ?? ((job) => job());
  return runExclusive(() => rememberLearnedPushToken(deps, token));
}

/**
 * The lane step of `reconcileRememberedPushToken`: re-read the storage and,
 * only while it still remembers nothing, write `token`. A token remembered
 * meanwhile (a registration's `PUT` that answered first, whose write ran in
 * this lane ahead of this step) wins and is answered instead, unwritten. The
 * step is bounded like every other lane step, so a stalled storage read or
 * write cannot hold up a sign-out queued behind it; the bound, a re-read that
 * rejects, and a re-read that answers only after the bound all end in `null`
 * with nothing written, because whether a newer token landed is then unknown.
 * A write that fails still answers `token`, as registration's does: the card
 * knows the token for this mount.
 */
async function rememberLearnedPushToken(
  deps: ReconcileDeps,
  token: string,
): Promise<string | null> {
  try {
    return await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, async (signal) => {
      const remembered = rememberedFrom(await deps.readRememberedPushToken());
      if (remembered !== null) return remembered;
      if (signal.aborted) return null;
      try {
        await deps.rememberPushToken(token);
      } catch {
        // Best effort, as registration's write is.
      }
      return token;
    });
  } catch {
    return null;
  }
}

/**
 * design.md "Me": the registration state the card renders. The button shows
 * a spinner while `registering`; `error` adds one line under the fields.
 */
export type PushTokenStatus =
  { kind: 'idle' } | { kind: 'registering' } | { kind: 'error'; message: string };

/** One registration attempt: its state, tagged with the user whose press started it. */
export type PushTokenAttempt = { userId: string | undefined; status: PushTokenStatus };

const IDLE: PushTokenStatus = { kind: 'idle' };

/**
 * The status the Me card renders for the signed-in user: the attempt's while
 * that user is still the one who pressed the button, `idle` otherwise. The
 * card stays mounted across a magic-link switch to another account, and
 * `registerPushToken` compares the session only around the `PUT`, so an
 * attempt that ends in `permission_denied`, `unsupported` or a failed `PUT`
 * after the switch, or one still in flight, would otherwise leave the
 * previous user's error line or disabled button on the new user's card.
 */
export function visiblePushTokenStatus(
  attempt: PushTokenAttempt,
  currentUserId: string | undefined,
): PushTokenStatus {
  return attempt.userId !== undefined && attempt.userId === currentUserId ? attempt.status : IDLE;
}

/**
 * The one line the Me screen shows for a failed registration (design.md
 * "Me"). `session_changed` shows nothing, so it is excluded here and the
 * screen handles it first.
 */
export function describePushTokenFailure(
  failure: Exclude<PushTokenFailure, { reason: 'session_changed' }>,
): string {
  switch (failure.reason) {
    case 'permission_denied':
      return 'Notifications are off for this app in Settings';
    case 'unsupported':
      return 'Push tokens need a physical device and an EAS project id';
    case 'api':
      return failure.status === null
        ? failure.message
        : `PUT /me/push-token returned ${failure.status}: ${failure.message}`;
  }
}
