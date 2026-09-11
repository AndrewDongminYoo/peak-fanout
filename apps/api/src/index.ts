import { Elysia } from 'elysia';

export const app = new Elysia().get('/health', () => ({ ok: true }));

export type App = typeof app;

// Listen only when this file is the entry point, so tests and Eden can import
// `app` without opening a port.
if (import.meta.main) {
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (Number.isNaN(port)) {
    throw new Error(`PORT must be a number, got "${process.env.PORT}"`);
  }
  app.listen(port);
  console.log(`api listening on http://localhost:${port}`);
}
