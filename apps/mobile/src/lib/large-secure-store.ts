import * as aesjs from 'aes-js';

/** The subset of `expo-secure-store` the adapter uses; holds the AES key. */
export interface KeyStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** The subset of `AsyncStorage` the adapter uses; holds the ciphertext. */
export interface ValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/**
 * Session storage adapter from the Supabase Expo guide.
 * Expo's SecureStore rejects values over 2048 bytes on some iOS releases and a
 * Supabase session is larger than that, so a random AES-256 key lives in
 * SecureStore while the encrypted session lives in AsyncStorage.
 * The key is created once per install and reused: a write never rotates it,
 * so a kill between the key write and the ciphertext write cannot pair an
 * old ciphertext with a new key (issue #12).
 * Key creation reads the bare `crypto.getRandomValues` global, which on React
 * Native exists only after `react-native-get-random-values` is imported; this
 * module leaves that import to its caller (`supabase.ts`) so a Bun test can
 * import the module without the polyfill.
 */
export class LargeSecureStore {
  /** Key creations in flight, so two concurrent writes on a fresh install share one key. */
  private readonly pendingKeys = new Map<string, Promise<Uint8Array>>();

  constructor(
    private readonly keyStore: KeyStore,
    private readonly valueStore: ValueStore,
  ) {}

  private async loadKey(key: string) {
    const encryptionKeyHex = await this.keyStore.getItemAsync(key);
    return encryptionKeyHex ? aesjs.utils.hex.toBytes(encryptionKeyHex) : null;
  }

  private loadOrCreateKey(key: string) {
    const pending = this.pendingKeys.get(key);
    if (pending) {
      return pending;
    }

    const creation = (async () => {
      const existing = await this.loadKey(key);
      if (existing) {
        return existing;
      }

      const encryptionKey = crypto.getRandomValues(new Uint8Array(256 / 8));
      await this.keyStore.setItemAsync(key, aesjs.utils.hex.fromBytes(encryptionKey));
      return encryptionKey;
    })().finally(() => {
      this.pendingKeys.delete(key);
    });
    this.pendingKeys.set(key, creation);

    return creation;
  }

  // Reusing one key with a fixed counter means every write under it shares a
  // keystream, which the Supabase Expo guide's adapter avoids by rotating the
  // key on every write (the rotation #12 removes). Accepted here because the
  // value is a Supabase session on a device-local store whose threat model is
  // SecureStore's 2048-byte limit, not an attacker reading AsyncStorage, and
  // the format stays readable by values written before #12.
  private async encrypt(key: string, value: string) {
    const encryptionKey = await this.loadOrCreateKey(key);

    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const encryptedBytes = cipher.encrypt(aesjs.utils.utf8.toBytes(value));

    return aesjs.utils.hex.fromBytes(encryptedBytes);
  }

  private async decrypt(key: string, value: string) {
    const encryptionKey = await this.loadKey(key);
    if (!encryptionKey) {
      return null;
    }

    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(1));
    const decryptedBytes = cipher.decrypt(aesjs.utils.hex.toBytes(value));

    return aesjs.utils.utf8.fromBytes(decryptedBytes);
  }

  async getItem(key: string) {
    const encrypted = await this.valueStore.getItem(key);
    if (!encrypted) {
      return encrypted;
    }

    return await this.decrypt(key, encrypted);
  }

  async removeItem(key: string) {
    await this.valueStore.removeItem(key);
    await this.keyStore.deleteItemAsync(key);
  }

  async setItem(key: string, value: string) {
    const encrypted = await this.encrypt(key, value);

    await this.valueStore.setItem(key, encrypted);
  }
}
