import { describe, expect, it } from 'bun:test';

import { createSignInCompleter, parseAuthCallback } from './auth-callback';

const CALLBACK_URL = 'https://peak-fanout-links.vercel.app/auth/callback';
const FLOW_ID = '1234567890abcdef1234567890abcdef';
const LINK = `${CALLBACK_URL}?sb_flow_id=${FLOW_ID}&code=one-time-code`;

describe('PKCE callback URL', () => {
  it('reads only a code bound to the configured HTTPS callback and flow ID', () => {
    expect(parseAuthCallback(LINK, CALLBACK_URL)).toEqual({
      kind: 'code',
      code: 'one-time-code',
      flowId: FLOW_ID,
    });
  });

  it('rejects a custom scheme, another host, missing flow ID, and URL tokens', () => {
    for (const url of [
      `peakfanout://auth/callback?sb_flow_id=${FLOW_ID}&code=one-time-code`,
      `https://attacker.example/auth/callback?sb_flow_id=${FLOW_ID}&code=one-time-code`,
      `${CALLBACK_URL}?code=one-time-code`,
      `${LINK}#access_token=stolen&refresh_token=stolen`,
    ]) {
      expect(parseAuthCallback(url, CALLBACK_URL).kind).not.toBe('code');
    }
  });
});

describe('PKCE sign-in completion', () => {
  it('exchanges the code with its flow ID before creating the app user', async () => {
    const events: string[] = [];
    const completeSignIn = createSignInCompleter({
      callbackUrl: CALLBACK_URL,
      async exchangeCode(code: string, flowId: string) {
        events.push(`exchange:${code}:${flowId}`);
        return { userId: 'user-a' };
      },
      async createUser() {
        events.push('createUser');
      },
      async signOutLocal() {
        events.push('signOutLocal');
      },
    });

    expect(await completeSignIn(LINK)).toBe('signed-in');
    expect(events).toEqual([`exchange:one-time-code:${FLOW_ID}`, 'createUser']);
  });

  it('keeps the stored session when no local PKCE verifier matches the code', async () => {
    const events: string[] = [];
    const completeSignIn = createSignInCompleter({
      callbackUrl: CALLBACK_URL,
      async exchangeCode() {
        events.push('exchange');
        throw new Error('PKCE code verifier not found');
      },
      async createUser() {
        events.push('createUser');
      },
      async signOutLocal() {
        events.push('signOutLocal');
      },
      async getSession() {
        return { userId: 'stored-user', accessToken: 'stored-access' };
      },
    });

    await expect(completeSignIn(LINK)).rejects.toThrow('PKCE code verifier not found');
    expect(events).toEqual(['exchange']);
  });
});
