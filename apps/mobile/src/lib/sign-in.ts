import { api, toApiError } from '@/lib/api';
import { createSignInCompleter } from '@/lib/auth-callback';
import { createSerialLane } from '@/lib/concurrency';
import type { SessionSnapshot } from '@/lib/push-token';
import { supabase } from '@/lib/supabase';

/** `POST /auth/session` with the current session's token; the `users` upsert behind sign-in and the Me screen's 404 repair. */
export async function createUser() {
  const session = await api.auth.session.post();
  if (session.error) throw toApiError(session.error);
}

/**
 * design.md "Me" and "Auth callback": the one lane that orders the
 * session-bound push-token writes on this device (registration's `PUT`, the
 * sign-out clear, the magic-link clear and the sign-in behind it), so an
 * earlier write lands before a later one is sent.
 */
export const sessionLane = createSerialLane();

/**
 * `DELETE /me/push-token`, signed as `accessToken`: the per-call header
 * replaces the one `api`'s `headers()` reads from the session at send time
 * (Eden spreads request headers over the client's), so the clear is signed
 * as the account whose token is being cleared, not as whoever a magic link
 * signed in since. `signal` reaches `fetch` the same way (Eden spreads the
 * per-call `fetch` init), so the caller's bound aborts the request. Resolves
 * the `GET /me` body with `push_token: null`, so the caller can update the
 * cache as after a `PUT`. Rejects on a non-2xx (`ApiError`), a failed
 * request or an abort: the callers decide what a failure means.
 */
export async function clearPushToken(accessToken: string, signal: AbortSignal) {
  const { data, error } = await api.me['push-token'].delete(undefined, {
    headers: { authorization: `Bearer ${accessToken}` },
    fetch: { signal },
  });
  if (error) throw toApiError(error);
  return data;
}

/**
 * One read of the stored Supabase session. A failed read (a refresh that
 * failed, a storage error auth-js caught) comes back as `error` with a null
 * session; it is thrown so `registerPushToken` reports it as `api` and the
 * screen shows it, instead of reading the null session as an account switch
 * and hiding it. `undefined` is a device with no session.
 */
export async function getSession(): Promise<SessionSnapshot | undefined> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) return undefined;
  return { userId: data.session.user.id, accessToken: data.session.access_token };
}

/** The magic-link completer wired to supabase-js and the Eden client; see `createSignInCompleter`. */
export const completeSignIn = createSignInCompleter({
  setSession: (tokens) => supabase.auth.setSession(tokens),
  createUser,
  signOutLocal: () => supabase.auth.signOut({ scope: 'local' }),
  getSession,
  clearPushToken,
  runExclusive: sessionLane,
});
