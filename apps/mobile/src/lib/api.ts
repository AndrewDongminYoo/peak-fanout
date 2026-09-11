import { treaty } from '@elysiajs/eden';
import type { App } from '@peak-fanout/api';

import { requirePublicEnv } from '@/lib/env';
import { supabase } from '@/lib/supabase';

/**
 * Eden treaty client for `apps/api`. Type-only import of `App`: the server
 * code never enters the bundle. Every request carries the current Supabase
 * access token, so a signed-out call reaches the API without a header and
 * gets the 401 design.md specifies.
 */
export const api = treaty<App>(
  requirePublicEnv('EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL),
  {
    async headers() {
      const { data } = await supabase.auth.getSession();
      if (!data.session) return;
      return { authorization: `Bearer ${data.session.access_token}` };
    },
  },
);

/** A non-2xx response from `apps/api`, with the status the screen can show. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Turn an Eden `error` into an `ApiError` using the body shapes from design.md. */
export function toApiError(error: { status: number; value: unknown }): ApiError {
  const value = error.value;
  if (value && typeof value === 'object' && 'error' in value) {
    const body = value as { error: string; reason?: string };
    return new ApiError(error.status, body.reason ? `${body.error} (${body.reason})` : body.error);
  }
  if (value instanceof Error) {
    return new ApiError(error.status, value.message);
  }
  return new ApiError(error.status, `request failed with status ${error.status}`);
}
