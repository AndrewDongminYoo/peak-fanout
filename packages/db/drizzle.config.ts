import { defineConfig } from 'drizzle-kit';

// `generate` and `check` are offline and never read the URL.
// `migrate` needs it; drizzle-kit reports the missing credentials itself.
const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  ...(url ? { dbCredentials: { url } } : {}),
});
