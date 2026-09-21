import { createSerialLane, withTimeout, type SerialLane } from '@/lib/concurrency';
import { PUSH_TOKEN_WRITE_TIMEOUT_MS, type SessionSnapshot } from '@/lib/push-token';

export type AuthCallback =
  | { kind: 'tokens'; accessToken: string; refreshToken: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

function decode(part: string) {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/** Parse `a=1&b=2`; later keys do not overwrite earlier ones. */
function parsePairs(source: string, into: Map<string, string>) {
  for (const pair of source.split('&')) {
    if (!pair) continue;
    const separator = pair.indexOf('=');
    const key = decode(separator >= 0 ? pair.slice(0, separator) : pair);
    const value = separator >= 0 ? decode(pair.slice(separator + 1)) : '';
    if (!into.has(key)) into.set(key, value);
  }
}

/**
 * Read the session Supabase Auth appended to the deep link.
 * The implicit flow puts `access_token` and `refresh_token` in the fragment
 * (`peakfanout://auth/callback#access_token=…`), and failures arrive as
 * `error` and `error_description`. The query string is read too, in case a
 * mail client rewrites `#` to `?`.
 */
export function parseAuthCallback(url: string): AuthCallback {
  const hashIndex = url.indexOf('#');
  const fragment = hashIndex >= 0 ? url.slice(hashIndex + 1) : '';
  const beforeHash = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const queryIndex = beforeHash.indexOf('?');
  const query = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';

  const params = new Map<string, string>();
  parsePairs(fragment, params);
  parsePairs(query, params);

  const error = params.get('error_description') ?? params.get('error');
  if (error) return { kind: 'error', message: error };

  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (accessToken && refreshToken) return { kind: 'tokens', accessToken, refreshToken };

  return { kind: 'none' };
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Decode one base64url segment (RFC 7515 §2; trailing `=` padding is
 * tolerated) to a string. Self-contained rather than `atob` + `TextDecoder`:
 * neither is asserted here for both Hermes and `bun test`, and auth-js keeps
 * its own decoder for the same reason. The bytes are percent-encoded and
 * handed to `decodeURIComponent`, which decodes UTF-8 and throws on an
 * invalid sequence; a character outside the alphabet throws too.
 */
function decodeBase64Url(segment: string): string {
  let bits = 0;
  let buffer = 0;
  let encoded = '';
  for (const char of segment.replace(/=+$/, '')) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value < 0) throw new Error(`not base64url: ${char}`);
    buffer = ((buffer << 6) | value) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      encoded += `%${((buffer >> bits) & 0xff).toString(16).padStart(2, '0')}`;
    }
  }
  return decodeURIComponent(encoded);
}

/**
 * The `sub` claim of a JWT, read without verifying the signature. The auth
 * callback uses it only to decide whether the incoming link names a different
 * user than the stored session, before the token is sent anywhere; the API
 * verifies the same token when it is used. Anything that is not a JWT with a
 * JSON payload carrying a string `sub` reads as `undefined`.
 */
export function readSubject(accessToken: string): string | undefined {
  const payload = accessToken.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims: unknown = JSON.parse(decodeBase64Url(payload));
    if (typeof claims !== 'object' || claims === null || !('sub' in claims)) return undefined;
    return typeof claims.sub === 'string' ? claims.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What the sign-in flow needs from supabase-js and the API client. Injected so
 * the flow runs under `bun test` without the React Native modules behind them;
 * `sign-in.ts` supplies the real ones.
 */
export type SignInDeps = {
  setSession(tokens: {
    access_token: string;
    refresh_token: string;
  }): Promise<{ error: Error | null }>;
  /** `POST /auth/session`; rejects when the API refuses or the request fails. */
  createUser(): Promise<void>;
  /** Drop the persisted session on this device only. */
  signOutLocal(): Promise<unknown>;
  /** The session the device holds before this link is applied; `undefined` when signed out. May reject when the session storage fails. */
  getSession?(): Promise<SessionSnapshot | undefined>;
  /** `DELETE /me/push-token` signed as `accessToken`, aborted through `signal` at the bound; rejects when the API refuses or the request fails. */
  clearPushToken?(accessToken: string, signal: AbortSignal): Promise<unknown>;
  /**
   * The lane shared with push-token registration and sign-out (`sign-in.ts`
   * supplies the instance), entered for the clear and `setSession` only;
   * absent, that step runs at once. Links are ordered among themselves by the
   * completer's own chain either way.
   */
  runExclusive?: SerialLane;
};

/**
 * design.md "Auth callback": before a link for user B is applied on a device
 * still holding user A's session, clear A's push token so the worker stops
 * sending A's reminders to a device that is about to belong to B. Best effort:
 * a session read or a clear that fails leaves A's token in place until A signs
 * out or registers elsewhere, and never fails B's sign-in. A link for the same
 * user (a refresh, a second link) skips the clear so the device keeps its
 * registration when the sign-in succeeds; so does a token whose subject cannot
 * be read, because `setSession` is about to reject it anyway. In both cases
 * the stored session's access token is returned, because a sign-in that fails
 * drops that session, and `clearKeptPushToken` needs a token that can still
 * sign the request. The whole step is bounded by `PUSH_TOKEN_WRITE_TIMEOUT_MS`
 * and the request aborted then, because it runs inside the lane and a stalled
 * clear would otherwise hold every later link, registration and sign-out on
 * the device.
 *
 * @returns the access token of a stored session whose push token was kept;
 * `undefined` when no session is stored, a clear was attempted (whether or
 * not it succeeded), the read failed, or the deps are absent.
 */
async function clearPreviousAccountPushToken(
  deps: SignInDeps,
  incomingAccessToken: string,
): Promise<string | undefined> {
  const { getSession, clearPushToken } = deps;
  if (!getSession || !clearPushToken) return undefined;
  const incomingUserId = readSubject(incomingAccessToken);
  try {
    return await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, async (signal) => {
      const stored = await getSession();
      if (stored === undefined) return undefined;
      if (incomingUserId === undefined || stored.userId === incomingUserId) {
        return stored.accessToken;
      }
      await clearPushToken(stored.accessToken, signal);
      return undefined;
    });
  } catch {
    // Best effort; see above.
    return undefined;
  }
}

/**
 * design.md "Auth callback": a sign-in that fails after
 * `clearPreviousAccountPushToken` kept the stored account's registration is
 * about to drop that session, and once it is gone no later link can clear
 * the account's token (the stored-session read above finds nothing). So the
 * token is cleared first, signed with the access token captured before
 * `setSession`, under the same bound; best effort, a clear that fails still
 * lets the local sign-out run. `keptAccessToken` is `undefined` whenever
 * there is nothing to clear.
 */
async function clearKeptPushToken(deps: SignInDeps, keptAccessToken: string | undefined) {
  const { clearPushToken } = deps;
  if (keptAccessToken === undefined || !clearPushToken) return;
  try {
    await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, (signal) =>
      clearPushToken(keptAccessToken, signal),
    );
  } catch {
    // Best effort; see above.
  }
}

export type SignInOutcome = 'signed-in';

/**
 * Build `completeSignIn`, which finishes a magic-link sign-in from the deep
 * link: persist the session, then create the `users` row through
 * `POST /auth/session`.
 *
 * Attempts run strictly one at a time, in arrival order: an attempt's
 * `setSession` and `POST /auth/session` both finish before the next attempt
 * touches the store. Each attempt ends in one of two states — its session is
 * persisted and its POST succeeded, or no session is persisted — because any
 * failure after the write begins is followed by a local sign-out before the
 * error is rethrown. So the last link to complete is the one whose session
 * the device holds, and a failed earlier link has already signed out before
 * the next one writes; no attempt needs to know about any other.
 *
 * Sequencing matters because supabase-js validates the token over the network
 * before it saves the session, and `signOut` calls the server before it
 * removes the stored one: two concurrent calls would persist in response
 * order, letting an older link's slower write land on top of the newer
 * account's session, or a slow sign-out wipe a session the next link had
 * just saved.
 *
 * The sign-out is local only: the default `scope: 'global'` would revoke
 * every refresh token the user holds, signing out their other devices over a
 * transient API error. It also runs when `setSession` itself fails, because
 * auth-js returns that error without clearing a session an earlier link may
 * have stored, and the invariant above must hold either way. Before either
 * sign-out, the push token of the account whose session was stored before the
 * attempt and whose clear was skipped is cleared (`clearKeptPushToken`), so a
 * signed-out device does not keep receiving that account's reminders.
 *
 * Inside its turn in that chain, an attempt enters `deps.runExclusive`, the
 * lane push-token registration and sign-out share (design.md "Me"), for the
 * clear and `setSession` only: a registration `PUT` in flight when a link
 * arrives lands before the link's clear (bar the abandoned `PUT` design.md
 * "Me" describes), and a registration or sign-out
 * started while a link is in progress waits until the link has stored its
 * session, so it reads that session rather than the one the link replaced.
 * `POST /auth/session` runs after the lane step, because it neither touches
 * the push token nor changes the stored session, and a slow one must not
 * hold up a sign-out; when it fails, its clear and local sign-out enter the
 * lane as one further step, so a registration queued behind them reads no
 * session. Nothing inside the lane waits on the chain, so the nesting cannot
 * deadlock. `setSession` and the local sign-outs have no bound of their own;
 * only the push-token writes do.
 */
export function createSignInCompleter(deps: SignInDeps) {
  /** The attempt chain; kept settled-resolved so one failure does not block the next attempt. */
  const attempts = createSerialLane();
  const runExclusive: SerialLane = deps.runExclusive ?? ((job) => job());

  return async function completeSignIn(url: string): Promise<SignInOutcome> {
    // Parsing touches nothing, so an unusable link rejects right away instead
    // of waiting behind a valid link that is still on the wire.
    const parsed = parseAuthCallback(url);
    if (parsed.kind === 'error') throw new Error(parsed.message);
    if (parsed.kind === 'none') {
      throw new Error('This link does not contain a session. Request a new magic link.');
    }

    return attempts(async (): Promise<SignInOutcome> => {
      // The stored account's access token when its registration was kept;
      // both failure paths clear it before they sign out.
      const keptAccessToken = await runExclusive(async () => {
        // Inside the lane, so the stored session it reads is the one the
        // previous step left, and this attempt's write has not started.
        const kept = await clearPreviousAccountPushToken(deps, parsed.accessToken);
        try {
          const saved = await deps.setSession({
            access_token: parsed.accessToken,
            refresh_token: parsed.refreshToken,
          });
          if (saved.error) throw saved.error;
        } catch (cause) {
          // Still inside the lane, so the next lane step never reads a
          // session this failed write left behind.
          await clearKeptPushToken(deps, kept);
          await deps.signOutLocal();
          throw cause;
        }
        return kept;
      });
      try {
        // Eden reports a failed fetch as `error`, but a body stream that dies
        // mid-read or a rejected `headers()` callback makes `post()` throw
        // instead; `createUser` folds both into a rejection, so one catch
        // covers the call.
        await deps.createUser();
      } catch (cause) {
        await runExclusive(async () => {
          await clearKeptPushToken(deps, keptAccessToken);
          await deps.signOutLocal();
        });
        throw cause;
      }
      return 'signed-in';
    });
  };
}

/** What the Me query needs; `index.tsx` supplies the Eden calls, tests supply fakes. */
export type MeDeps<Me> = {
  /** `GET /me`; rejects with the `ApiError` from `toApiError`, whose `status` is the response status. */
  getMe(): Promise<Me>;
  /** `POST /auth/session`; rejects when the API refuses or the request fails. */
  createUser(): Promise<void>;
};

function isNotFound(cause: unknown) {
  return typeof cause === 'object' && cause !== null && 'status' in cause && cause.status === 404;
}

/**
 * `GET /me`, repairing a session that was persisted without its `users` row.
 * `completeSignIn` signs out when either of its steps fails, but the app can
 * die after `setSession` wrote the store and before `POST /auth/session`
 * returned; the next launch restores that session, and `GET /me` answers
 * 404. A 404 here means the token verified and no row exists (a missing
 * or bad token gets 401), so the upsert `completeSignIn` skipped runs once
 * and `GET /me` is retried once. Any other failure, and a second 404, reach
 * the screen as they would without the repair.
 */
export async function fetchMeWithRecovery<Me>(deps: MeDeps<Me>): Promise<Me> {
  try {
    return await deps.getMe();
  } catch (cause) {
    if (!isNotFound(cause)) throw cause;
  }
  await deps.createUser();
  return deps.getMe();
}

/** TanStack Query's client-side default retry count (`config.retry ?? 3` in query-core). */
const DEFAULT_QUERY_RETRIES = 3;

/**
 * The Me query's `retry` option. TanStack Query reruns the whole query
 * function on every retry, so a persistent 404 that `fetchMeWithRecovery`
 * already repaired once would otherwise cost four `POST /auth/session` and
 * eight `GET /me` before the screen shows the error. A 404 is terminal (the
 * helper has spent its one upsert and one retry); every other failure keeps
 * the default three retries.
 */
export function shouldRetryMe(failureCount: number, error: Error): boolean {
  return !isNotFound(error) && failureCount < DEFAULT_QUERY_RETRIES;
}

/** What the sign-out button needs; `index.tsx` supplies `supabase.auth.signOut`, `clearPushToken` and the shared lane, tests supply fakes. */
export type SignOutDeps = {
  signOut(): Promise<{ error: { message: string } | null }>;
  /** `DELETE /me/push-token` with the current session, aborted through `signal` at the bound; rejects when the API refuses or the request fails. */
  clearPushToken?(signal: AbortSignal): Promise<unknown>;
  /** The lane shared with push-token registration and the auth callback; absent, the sign-out runs at once. */
  runExclusive?: SerialLane;
};

/**
 * Sign out and report the failure instead of dropping it. auth-js 2.116.0
 * `_signOut` returns `{ error }` without removing the stored session when the
 * session cannot be loaded first (an expired token whose refresh fails
 * offline), so no `SIGNED_OUT` event fires, the guard never routes to
 * `/login`, and the user is still signed in; the screen must say so and offer
 * a retry. A rejection is folded into the same shape so the button never
 * leaves an unhandled promise behind. Resolves `null` on success.
 *
 * design.md "Me": the push token is cleared first, while the session can
 * still sign the request, so the worker stops sending this account's
 * reminders to a device it no longer owns. Best effort: a clear that fails
 * (rejected request, non-2xx, or no answer within
 * `PUSH_TOKEN_WRITE_TIMEOUT_MS`, after which the request is aborted) is
 * ignored, sign-out proceeds, and the row keeps its token until the next
 * registration or a later clear. Clear and sign-out are one step in
 * `runExclusive`, the lane registration shares, so a `PUT` in flight when
 * the button is pressed lands first and is then cleared (bar the abandoned
 * `PUT` design.md "Me" describes), and a registration pressed after the
 * button reads no session and skips its `PUT`.
 */
export async function signOutWithFeedback(deps: SignOutDeps): Promise<string | null> {
  const { clearPushToken } = deps;
  const runExclusive: SerialLane = deps.runExclusive ?? ((job) => job());
  return runExclusive(async () => {
    if (clearPushToken) {
      try {
        await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, (signal) => clearPushToken(signal));
      } catch {
        // Best effort; see above.
      }
    }
    try {
      const { error } = await deps.signOut();
      return error ? error.message : null;
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause);
    }
  });
}
