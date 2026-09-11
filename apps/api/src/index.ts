import { Elysia } from 'elysia';

export const app = new Elysia().get('/health', () => ({ ok: true }));

export type App = typeof app;

/**
 * Parse the `PORT` environment value. Empty or unset falls back to 3000.
 * The whole value must be a decimal integer in 0-65535: `Number.parseInt`
 * would silently accept "3000abc" or "3000.5" as 3000.
 */
export function parsePort(raw: string | undefined): number {
  const value = raw || '3000';
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port > 65535) {
    throw new Error(`PORT must be an integer in 0-65535, got "${raw}"`);
  }
  return port;
}

// Listen only when this file is the entry point, so tests and Eden can import
// `app` without opening a port.
if (import.meta.main) {
  const port = parsePort(process.env.PORT);
  app.listen(port);
  console.log(`api listening on http://localhost:${port}`);
}
