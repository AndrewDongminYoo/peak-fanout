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
   * session the API client would read at send time; rejects with the
   * `ApiError` from `toApiError`, or a plain error when the request itself fails.
   */
  putPushToken(token: string, accessToken: string): Promise<Me>;
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
 * Either mismatch is `session_changed`, which the screen drops without an
 * error line. A session read that rejects (`LargeSecureStore` behind
 * `supabase.auth.getSession()` throws through auth-js uncaught) is `api` with
 * a `null` status before the `PUT`, because the request could not be signed,
 * and `session_changed` after it, because the user to cache the body under
 * cannot be confirmed.
 */
export async function registerPushToken<Me>(deps: PushTokenDeps<Me>): Promise<PushTokenResult<Me>> {
  const { projectId, userId } = deps;
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

  let me: Me;
  try {
    me = await deps.putPushToken(token, session.accessToken);
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

  let sessionAfter: SessionSnapshot | undefined;
  try {
    sessionAfter = await deps.getSession();
  } catch {
    return {
      ok: false,
      reason: 'session_changed',
      message: 'could not confirm the signed-in user after the token was stored',
    };
  }
  if (sessionAfter?.userId !== userId) {
    return {
      ok: false,
      reason: 'session_changed',
      message: 'signed-in user changed after the token was stored',
    };
  }
  return { ok: true, me };
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
