/**
 * Read an `EXPO_PUBLIC_*` value that Metro inlined at build time, failing
 * loudly at startup instead of at the first network call.
 */
export function requirePublicEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Set it in apps/mobile/.env (start from apps/mobile/.env.example); ` +
        'EXPO_PUBLIC_SUPABASE_ANON_KEY is the anon key that `bun run supabase:status` prints.',
    );
  }
  return value;
}
