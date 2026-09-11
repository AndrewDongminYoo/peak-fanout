/**
 * Read an `EXPO_PUBLIC_*` value that Metro inlined at build time, failing
 * loudly at startup instead of at the first network call.
 */
export function requirePublicEnv(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `${name} is not set. Copy apps/mobile/.env.example to apps/mobile/.env and fill it in; ` +
        `the comment above ${name} there says where the value comes from.`,
    );
  }
  return value;
}
