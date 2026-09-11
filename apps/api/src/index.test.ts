import { describe, expect, it } from 'bun:test';

import { app } from './index';

describe('GET /health', () => {
  it('returns { ok: true } with status 200', async () => {
    const response = await app.handle(new Request('http://localhost/health'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('does not open a port when imported', () => {
    expect(app.server).toBeNull();
  });
});
