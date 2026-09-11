import { describe, expect, it } from 'bun:test';

import { parsePort, requireEnv } from './index';

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

describe('requireEnv', () => {
  it('returns the value when set', () => {
    expect(requireEnv('SUPABASE_JWT_SECRET', { SUPABASE_JWT_SECRET: 'value-from-env' })).toBe(
      'value-from-env',
    );
  });

  it('names the variable when it is missing or empty', () => {
    expect(() => requireEnv('DATABASE_URL', {})).toThrow('DATABASE_URL is required');
    expect(() => requireEnv('DATABASE_URL', { DATABASE_URL: '' })).toThrow(
      'DATABASE_URL is required',
    );
  });
});
