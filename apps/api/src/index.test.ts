import { describe, expect, it } from 'bun:test';

import { parsePort, requireEnv, supabaseJwksUrl } from './index';

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

describe('supabaseJwksUrl', () => {
  it('accepts https on any host', () => {
    expect(supabaseJwksUrl('https://x.supabase.co').href).toBe(
      'https://x.supabase.co/auth/v1/.well-known/jwks.json',
    );
  });

  it('accepts http only on a loopback host, in every form the parser produces', () => {
    for (const url of ['http://127.0.0.1:54321', 'http://localhost:54321', 'http://[::1]:54321']) {
      expect(supabaseJwksUrl(url).href).toBe(`${url}/auth/v1/.well-known/jwks.json`);
    }
  });

  it('refuses plaintext http to a non-loopback host, naming the variable and the rule', () => {
    for (const url of ['http://10.0.0.5:54321', 'http://example.com']) {
      expect(() => supabaseJwksUrl(url)).toThrow(
        /^SUPABASE_URL must use https:, or http: only on a loopback host/,
      );
      expect(() => supabaseJwksUrl(url)).toThrow(url);
    }
  });

  it('refuses any other scheme, loopback or not', () => {
    expect(() => supabaseJwksUrl('ftp://127.0.0.1')).toThrow(/^SUPABASE_URL must use https:/);
  });
});
