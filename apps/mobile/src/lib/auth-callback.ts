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
};

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
 * have stored, and the invariant above must hold either way.
 */
export function createSignInCompleter(deps: SignInDeps) {
  /** The tail of the attempt chain; kept settled-resolved so one failure does not block the next attempt. */
  let attempts: Promise<unknown> = Promise.resolve();

  return async function completeSignIn(url: string): Promise<SignInOutcome> {
    // Parsing touches nothing, so an unusable link rejects right away instead
    // of waiting behind a valid link that is still on the wire.
    const parsed = parseAuthCallback(url);
    if (parsed.kind === 'error') throw new Error(parsed.message);
    if (parsed.kind === 'none') {
      throw new Error('This link does not contain a session. Request a new magic link.');
    }

    const attempt = attempts.then(async (): Promise<SignInOutcome> => {
      try {
        const saved = await deps.setSession({
          access_token: parsed.accessToken,
          refresh_token: parsed.refreshToken,
        });
        if (saved.error) throw saved.error;
        // Eden reports a failed fetch as `error`, but a body stream that dies
        // mid-read or a rejected `headers()` callback makes `post()` throw
        // instead; `createUser` folds both into a rejection, so one catch
        // covers the call.
        await deps.createUser();
      } catch (cause) {
        await deps.signOutLocal();
        throw cause;
      }
      return 'signed-in';
    });
    attempts = attempt.catch(() => undefined);
    return attempt;
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
