import { createSerialLane, withTimeout, type SerialLane } from '@/lib/concurrency';
import { PUSH_TOKEN_WRITE_TIMEOUT_MS, type SessionSnapshot } from '@/lib/push-token';

export type AuthCallback =
  | { kind: 'code'; code: string; flowId: string }
  | { kind: 'error'; message: string }
  | { kind: 'none' };

const PKCE_FLOW_ID = /^[a-zA-Z0-9_-]{8,64}$/;
const TOKEN_PARAMETERS = ['access_token', 'refresh_token', 'token_type'];

/** Read only a code from the configured verified HTTPS callback. */
export function parseAuthCallback(url: string, callbackUrl: string): AuthCallback {
  let incoming: URL;
  let expected: URL;
  try {
    incoming = new URL(url);
    expected = new URL(callbackUrl);
  } catch {
    return { kind: 'error', message: 'This is not a valid sign-in link.' };
  }
  if (
    incoming.protocol !== 'https:' ||
    incoming.origin !== expected.origin ||
    incoming.pathname !== expected.pathname ||
    incoming.username ||
    incoming.password
  ) {
    return { kind: 'error', message: 'This sign-in link is not for this app.' };
  }

  const query = incoming.searchParams;
  const fragment = new URLSearchParams(incoming.hash.slice(1));
  if (TOKEN_PARAMETERS.some((key) => query.has(key) || fragment.has(key))) {
    return { kind: 'error', message: 'Request a new magic link for this app.' };
  }
  const error =
    fragment.get('error_description') ??
    query.get('error_description') ??
    fragment.get('error') ??
    query.get('error');
  if (error) return { kind: 'error', message: error };

  const code = query.get('code');
  const flowId = query.get('sb_flow_id');
  if (
    !code ||
    !flowId ||
    !PKCE_FLOW_ID.test(flowId) ||
    query.getAll('code').length !== 1 ||
    query.getAll('sb_flow_id').length !== 1 ||
    Array.from(query.keys()).some((key) => key !== 'code' && key !== 'sb_flow_id') ||
    incoming.hash
  ) {
    return { kind: 'none' };
  }
  return { kind: 'code', code, flowId };
}

/** Dependencies are injected so the callback can be tested without React Native modules. */
export type SignInDeps = {
  callbackUrl: string;
  /** Exchanges only the verifier slot identified by `flowId` and persists the returned session. */
  exchangeCode(code: string, flowId: string): Promise<{ userId: string }>;
  createUser(): Promise<void>;
  signOutLocal(): Promise<unknown>;
  getSession?(): Promise<SessionSnapshot | undefined>;
  clearPushToken?(accessToken: string, signal: AbortSignal): Promise<unknown>;
  runExclusive?: SerialLane;
};

async function readPreviousSession(deps: SignInDeps): Promise<SessionSnapshot | undefined> {
  if (!deps.getSession) return undefined;
  try {
    return await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, () => deps.getSession!());
  } catch {
    // A failed read cannot prevent the new code from being exchanged.
    return undefined;
  }
}

async function clearKeptPushToken(deps: SignInDeps, accessToken: string | undefined) {
  if (accessToken === undefined || !deps.clearPushToken) return;
  try {
    await withTimeout(PUSH_TOKEN_WRITE_TIMEOUT_MS, (signal) =>
      deps.clearPushToken!(accessToken, signal),
    );
  } catch {
    // Best effort; the local sign-out must still run.
  }
}

export type SignInOutcome = 'signed-in';

/** Complete a verified magic link in arrival order and share the session lane with push-token writes. */
export function createSignInCompleter(deps: SignInDeps) {
  const attempts = createSerialLane();
  const runExclusive: SerialLane = deps.runExclusive ?? ((job) => job());

  return async function completeSignIn(url: string): Promise<SignInOutcome> {
    const parsed = parseAuthCallback(url, deps.callbackUrl);
    if (parsed.kind === 'error') throw new Error(parsed.message);
    if (parsed.kind === 'none') {
      throw new Error('This link does not contain a valid sign-in code. Request a new magic link.');
    }

    return attempts(async (): Promise<SignInOutcome> => {
      let previous: SessionSnapshot | undefined;
      let previousClearAttempted = false;
      await runExclusive(async () => {
        previous = await readPreviousSession(deps);
        const exchanged = await deps.exchangeCode(parsed.code, parsed.flowId);
        if (previous && previous.userId !== exchanged.userId) {
          previousClearAttempted = true;
          await clearKeptPushToken(deps, previous.accessToken);
        }
      });

      try {
        await deps.createUser();
      } catch (cause) {
        await runExclusive(async () => {
          if (previous && !previousClearAttempted) {
            await clearKeptPushToken(deps, previous.accessToken);
          }
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
 * die after code exchange wrote the store and before `POST /auth/session`
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
