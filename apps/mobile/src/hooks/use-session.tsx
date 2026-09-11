import type { Session } from '@supabase/supabase-js';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

import { supabase } from '@/lib/supabase';

type SessionState = {
  session: Session | null;
  /** True until the persisted session has been read once. */
  loading: boolean;
};

const SessionContext = createContext<SessionState>({ session: null, loading: true });

/**
 * Mirrors the Supabase session into React state; mount once at the root layout,
 * inside `QueryClientProvider`. Whenever the signed-in user changes (sign-out,
 * or a magic link for a different account) the query cache is cleared so no
 * screen keeps showing the previous user's `GET /me` data under the new session.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<SessionState>({ session: null, loading: true });
  const userId = useRef<string | null>(null);

  useEffect(() => {
    const apply = (session: Session | null) => {
      const nextUserId = session?.user.id ?? null;
      if (nextUserId !== userId.current) {
        userId.current = nextUserId;
        queryClient.clear();
      }
      setState({ session, loading: false });
    };
    supabase.auth.getSession().then(({ data }) => apply(data.session));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => apply(session));
    return () => subscription.unsubscribe();
  }, [queryClient]);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
