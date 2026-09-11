import { describe, expect, it } from 'bun:test';

import { app, parsePort } from './index';

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

describe('parsePort', () => {
  it('defaults to 3000 when PORT is unset or empty', () => {
    expect(parsePort(undefined)).toBe(3000);
    expect(parsePort('')).toBe(3000);
  });

  it('accepts a whole decimal integer in range', () => {
    expect(parsePort('8080')).toBe(8080);
    expect(parsePort('0')).toBe(0);
    expect(parsePort('65535')).toBe(65535);
  });

  it('rejects partially numeric values instead of truncating them', () => {
    expect(() => parsePort('3000abc')).toThrow('PORT must be an integer');
    expect(() => parsePort('3000.5')).toThrow('PORT must be an integer');
  });

  it('rejects non-decimal, negative, and out-of-range values', () => {
    expect(() => parsePort('abc')).toThrow('PORT must be an integer');
    expect(() => parsePort('0x10')).toThrow('PORT must be an integer');
    expect(() => parsePort('-1')).toThrow('PORT must be an integer');
    expect(() => parsePort('65536')).toThrow('PORT must be an integer');
  });
});
