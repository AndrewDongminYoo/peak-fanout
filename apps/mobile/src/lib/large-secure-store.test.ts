import * as aesjs from 'aes-js';
import { describe, expect, it } from 'bun:test';

import { LargeSecureStore, type KeyStore, type ValueStore } from './large-secure-store';

const KEY = 'sb-project-auth-token';
const SESSION_A = JSON.stringify({ access_token: 'a.access', refresh_token: 'a.refresh' });
const SESSION_B = JSON.stringify({ access_token: 'b.access', refresh_token: 'b.refresh' });

/** A promise settled by the test, so write ordering is under control. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * In-memory SecureStore and AsyncStorage. The key store counts its writes and
 * can hold each one open until the test releases it; the value store can be
 * told to throw on its next write, the way a kill between the two writes
 * leaves the ciphertext untouched after the key write already happened.
 */
function createFakeStores() {
  const keys = new Map<string, string>();
  const values = new Map<string, string>();
  const keyWrites: { value: string; release: () => void }[] = [];
  let holdKeyWrites = false;
  let valueWriteError: Error | null = null;

  const keyStore: KeyStore = {
    async getItemAsync(key) {
      return keys.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      const call = deferred();
      keyWrites.push({ value, release: call.resolve });
      if (holdKeyWrites) await call.promise;
      keys.set(key, value);
    },
    async deleteItemAsync(key) {
      keys.delete(key);
    },
  };

  const valueStore: ValueStore = {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      if (valueWriteError) {
        const error = valueWriteError;
        valueWriteError = null;
        throw error;
      }
      values.set(key, value);
    },
    async removeItem(key) {
      values.delete(key);
    },
  };

  return {
    keyStore,
    valueStore,
    keys,
    values,
    /** Every `setItemAsync` on the key store, in order. */
    keyWrites,
    holdKeyWrites() {
      holdKeyWrites = true;
    },
    failNextValueWrite(error: Error) {
      valueWriteError = error;
    },
  };
}

/** Let every pending microtask run so the adapter reaches its next `await`. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LargeSecureStore', () => {
  it('round-trips a value through the two stores', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);

    expect(await store.getItem(KEY)).toBe(SESSION_A);
    expect(fake.values.get(KEY)).not.toBe(SESSION_A);
    expect(fake.keys.get(KEY)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns null when nothing was stored', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    expect(await store.getItem(KEY)).toBeNull();
    expect(fake.keyWrites).toHaveLength(0);
  });

  it('creates the key once and reuses it on later writes', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);
    const firstKey = fake.keys.get(KEY);
    await store.setItem(KEY, SESSION_B);

    expect(fake.keyWrites).toHaveLength(1);
    expect(fake.keys.get(KEY)).toBe(firstKey);
    expect(await store.getItem(KEY)).toBe(SESSION_B);
  });

  // With one key per install, a fixed counter would give every write the same
  // keystream; each write draws its own IV instead.
  it('encrypts the same value differently on each write and reads both back', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);
    const first = fake.values.get(KEY)!;
    await store.setItem(KEY, SESSION_A);
    const second = fake.values.get(KEY)!;

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(fake.keyWrites).toHaveLength(1);
    expect(await store.getItem(KEY)).toBe(SESSION_A);
    fake.values.set(KEY, first);
    expect(await store.getItem(KEY)).toBe(SESSION_A);
  });

  it('returns null for a marked value whose IV is malformed', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);
    await store.setItem(KEY, SESSION_A);
    const ciphertextHex = fake.values.get(KEY)!.split(':')[2]!;

    for (const iv of ['zz'.repeat(16), 'ab'.repeat(15), '', 'v1']) {
      fake.values.set(KEY, `v1:${iv}:${ciphertextHex}`);
      expect(await store.getItem(KEY)).toBeNull();
    }
    fake.values.set(KEY, `v1:${ciphertextHex}`);
    expect(await store.getItem(KEY)).toBeNull();
  });

  // The adapter that lived in supabase.ts before #12 stored the key hex in
  // SecureStore and a Counter(1) CTR ciphertext hex, without the `v1:` marker,
  // in AsyncStorage; a session it wrote still reads back after the upgrade, and
  // the next write moves the value to the marked format under the same key.
  it('reads a value written by the adapter before #12', async () => {
    const fake = createFakeStores();
    const legacyKey = crypto.getRandomValues(new Uint8Array(256 / 8));
    const legacyCipher = new aesjs.ModeOfOperation.ctr(legacyKey, new aesjs.Counter(1));
    fake.keys.set(KEY, aesjs.utils.hex.fromBytes(legacyKey));
    fake.values.set(
      KEY,
      aesjs.utils.hex.fromBytes(legacyCipher.encrypt(aesjs.utils.utf8.toBytes(SESSION_A))),
    );
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    expect(await store.getItem(KEY)).toBe(SESSION_A);

    await store.setItem(KEY, SESSION_B);

    expect(fake.keyWrites).toHaveLength(0);
    expect(fake.keys.get(KEY)).toBe(aesjs.utils.hex.fromBytes(legacyKey));
    expect(fake.values.get(KEY)).toStartWith('v1:');
    expect(await store.getItem(KEY)).toBe(SESSION_B);
  });

  it('reuses a key another instance of the adapter created', async () => {
    const fake = createFakeStores();
    await new LargeSecureStore(fake.keyStore, fake.valueStore).setItem(KEY, SESSION_A);

    const relaunched = new LargeSecureStore(fake.keyStore, fake.valueStore);
    expect(await relaunched.getItem(KEY)).toBe(SESSION_A);
    await relaunched.setItem(KEY, SESSION_B);

    expect(fake.keyWrites).toHaveLength(1);
    expect(await relaunched.getItem(KEY)).toBe(SESSION_B);
  });

  // Issue #12: a kill between the key write and the ciphertext write. With
  // one key per install the ciphertext left behind still decrypts.
  it('keeps the first value readable when a later ciphertext write is interrupted', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);
    const firstKey = fake.keys.get(KEY);

    fake.failNextValueWrite(new Error('process killed'));
    await expect(store.setItem(KEY, SESSION_B)).rejects.toThrow('process killed');

    expect(fake.keys.get(KEY)).toBe(firstKey);
    expect(fake.keyWrites).toHaveLength(1);
    expect(await store.getItem(KEY)).toBe(SESSION_A);
  });

  it('shares one key between two concurrent writes on a fresh install', async () => {
    const fake = createFakeStores();
    fake.holdKeyWrites();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    const first = store.setItem(KEY, SESSION_A);
    const second = store.setItem(KEY, SESSION_B);
    await settle();

    // Only one key creation went out; the second write waits on it.
    expect(fake.keyWrites).toHaveLength(1);
    fake.keyWrites[0]!.release();
    await Promise.all([first, second]);

    expect(fake.keyWrites).toHaveLength(1);
    expect(await store.getItem(KEY)).toBe(SESSION_B);
  });

  it('creates a fresh key after removeItem, not the one it created earlier', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);
    await store.removeItem(KEY);
    await store.setItem(KEY, SESSION_B);

    expect(fake.keyWrites).toHaveLength(2);
    expect(fake.keys.get(KEY)).toBe(fake.keyWrites[1]!.value);
    expect(await store.getItem(KEY)).toBe(SESSION_B);
  });

  it('retries key creation after a failed key write', async () => {
    const fake = createFakeStores();
    const failing: KeyStore = {
      ...fake.keyStore,
      async setItemAsync() {
        throw new Error('keychain unavailable');
      },
    };
    const store = new LargeSecureStore(failing, fake.valueStore);

    await expect(store.setItem(KEY, SESSION_A)).rejects.toThrow('keychain unavailable');
    // The failed creation must not stay memoized for the next write.
    await expect(store.setItem(KEY, SESSION_A)).rejects.toThrow('keychain unavailable');
    expect(fake.values.has(KEY)).toBe(false);
  });

  // A wiped keychain, or a reinstall that kept AsyncStorage.
  it('returns null for a ciphertext whose key is gone and does not create one', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);
    fake.keys.delete(KEY);

    expect(await store.getItem(KEY)).toBeNull();
    expect(fake.keyWrites).toHaveLength(1);
    expect(fake.keys.has(KEY)).toBe(false);
  });

  it('removes both the ciphertext and the key', async () => {
    const fake = createFakeStores();
    const store = new LargeSecureStore(fake.keyStore, fake.valueStore);

    await store.setItem(KEY, SESSION_A);
    await store.removeItem(KEY);

    expect(fake.values.has(KEY)).toBe(false);
    expect(fake.keys.has(KEY)).toBe(false);
    expect(await store.getItem(KEY)).toBeNull();
  });
});
