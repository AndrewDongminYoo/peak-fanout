import { api, toApiError } from '@/lib/api';
import { createSignInCompleter } from '@/lib/auth-callback';
import { supabase } from '@/lib/supabase';

/** `POST /auth/session` with the current session's token; the `users` upsert behind sign-in and the Me screen's 404 repair. */
export async function createUser() {
  const session = await api.auth.session.post();
  if (session.error) throw toApiError(session.error);
}

/** The magic-link completer wired to supabase-js and the Eden client; see `createSignInCompleter`. */
export const completeSignIn = createSignInCompleter({
  setSession: (tokens) => supabase.auth.setSession(tokens),
  createUser,
  signOutLocal: () => supabase.auth.signOut({ scope: 'local' }),
});
