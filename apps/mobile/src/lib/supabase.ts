import 'react-native-url-polyfill/auto';
import 'react-native-get-random-values';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

import { requirePublicEnv } from '@/lib/env';
import { LargeSecureStore } from '@/lib/large-secure-store';

/** Where Supabase Auth sends the browser after a magic link; see design.md "Auth callback". */
export const AUTH_CALLBACK_URL = 'peakfanout://auth/callback';

export const supabase = createClient(
  requirePublicEnv('EXPO_PUBLIC_SUPABASE_URL', process.env.EXPO_PUBLIC_SUPABASE_URL),
  requirePublicEnv('EXPO_PUBLIC_SUPABASE_ANON_KEY', process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY),
  {
    auth: {
      // SecureStore has no web implementation; supabase-js falls back to localStorage there.
      storage: Platform.OS === 'web' ? undefined : new LargeSecureStore(SecureStore, AsyncStorage),
      autoRefreshToken: true,
      persistSession: true,
      // The magic link lands on /auth/callback, which hands the tokens to setSession itself.
      detectSessionInUrl: false,
    },
  },
);

// Outside a browser supabase-js cannot see visibility changes, so refresh the
// session only while the app is in the foreground (supabase-js `startAutoRefresh` docs).
AppState.addEventListener('change', (state) => {
  if (state === 'active') {
    supabase.auth.startAutoRefresh();
  } else {
    supabase.auth.stopAutoRefresh();
  }
});
