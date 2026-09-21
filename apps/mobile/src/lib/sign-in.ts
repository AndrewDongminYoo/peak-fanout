import AsyncStorage from '@react-native-async-storage/async-storage';

import { api, toApiError } from '@/lib/api';
import { createSignInCompleter } from '@/lib/auth-callback';
import { createSerialLane } from '@/lib/concurrency';
import { clearPushTokenBody, type SessionSnapshot } from '@/lib/push-token';
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
 * design.md "Me": where this installation keeps the Expo push token it last
 * registered. One key, not keyed by user, because the token names the
 * installation and outlives sign-out and account switches; only the next
 * successful `PUT` overwrites it. AsyncStorage, not `expo-secure-store`,
 * because a push token is not a secret. `bun test` has no AsyncStorage, so
 * this pair is injected into `push-token.ts` (`rememberPushToken`) and read
 * through `clearPushTokenBody` rather than imported there.
 */
const REGISTERED_PUSH_TOKEN_KEY = 'peak-fanout.registered-push-token';

/** `PushTokenDeps.rememberPushToken`: the token a 2xx `PUT /me/push-token` just stored. */
export function rememberPushToken(token: string) {
  return AsyncStorage.setItem(REGISTERED_PUSH_TOKEN_KEY, token);
}

/** The token the last successful registration on this installation remembered; `null` when none. */
function readRememberedPushToken() {
  return AsyncStorage.getItem(REGISTERED_PUSH_TOKEN_KEY);
}

/**
 * `DELETE /me/push-token`, signed as `accessToken`: the per-call header
 * replaces the one `api`'s `headers()` reads from the session at send time
 * (Eden spreads request headers over the client's), so the clear is signed
 * as the account whose token is being cleared, not as whoever a magic link
 * signed in since. `signal` reaches `fetch` the same way (Eden spreads the
 * per-call `fetch` init), so the caller's bound aborts the request. The body
 * names the token this installation remembered, when one is stored, so the
 * row is cleared only while it still holds it; with nothing remembered, or a
 * read that fails, no body goes out and the clear is unconditional (Eden
 * sends neither a body nor a `content-type` for `undefined`). The read runs
 * here, inside the caller's bounded step, so every clear path (sign-out and
 * both auth-callback clears) gets it without a signature change. Resolves
 * the `GET /me` body as the row now is (`push_token: null` after a match or
 * an unconditional clear, the other installation's token after a mismatch),
 * so the caller can update the cache as after a `PUT`. Rejects on a non-2xx
 * (`ApiError`), a failed request or an abort: the callers decide what a
 * failure means.
 */
export async function clearPushToken(accessToken: string, signal: AbortSignal) {
  const body = await clearPushTokenBody(readRememberedPushToken);
  const { data, error } = await api.me['push-token'].delete(body, {
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
