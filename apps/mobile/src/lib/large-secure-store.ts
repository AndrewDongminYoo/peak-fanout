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

/** Marks a ciphertext that carries its own CTR initial counter. */
const IV_FORMAT_PREFIX = 'v1:';
/** 16 IV bytes as hex; `aesjs.utils.hex.toBytes` does not reject other input. */
const IV_HEX = /^[0-9a-f]{32}$/i;

/**
 * Session storage adapter derived from the Supabase Expo guide.
 * Expo's SecureStore rejects values over 2048 bytes on some iOS releases and a
 * Supabase session is larger than that, so a random AES-256 key lives in
 * SecureStore while the encrypted session lives in AsyncStorage.
 * The key is created once per install and reused: a write never rotates it,
 * so a kill between the key write and the ciphertext write cannot pair an
 * old ciphertext with a new key (issue #12).
 * Because the key is shared by every write, each write draws a random 16-byte
 * IV as its CTR initial counter and stores it with the ciphertext as
 * `v1:<iv hex>:<ciphertext hex>`; a value without the `v1:` marker is one the
 * pre-#12 adapter wrote with `Counter(1)` and still decrypts that way.
 * Key and IV creation read the bare `crypto.getRandomValues` global, which on
 * React Native exists only after `react-native-get-random-values` is imported;
 * this module leaves that import to its caller (`supabase.ts`) so a Bun test
 * can import the module without the polyfill.
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

  // The Supabase Expo guide's adapter rotated the key on every write, so its
  // fixed Counter(1) never repeated a keystream; with one key per install a
  // fixed counter would, and a known plaintext/ciphertext pair would then
  // recover every later session written under the key. A fresh IV per write
  // keeps each keystream distinct.
  private async encrypt(key: string, value: string) {
    const encryptionKey = await this.loadOrCreateKey(key);

    const iv = crypto.getRandomValues(new Uint8Array(16));
    const ivHex = aesjs.utils.hex.fromBytes(iv);
    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, new aesjs.Counter(iv));
    const encryptedBytes = cipher.encrypt(aesjs.utils.utf8.toBytes(value));

    return `${IV_FORMAT_PREFIX}${ivHex}:${aesjs.utils.hex.fromBytes(encryptedBytes)}`;
  }

  private async decrypt(key: string, value: string) {
    const encryptionKey = await this.loadKey(key);
    if (!encryptionKey) {
      return null;
    }

    let counter: aesjs.Counter;
    let ciphertextHex: string;
    if (value.startsWith(IV_FORMAT_PREFIX)) {
      const separator = value.indexOf(':', IV_FORMAT_PREFIX.length);
      const ivHex = separator === -1 ? '' : value.slice(IV_FORMAT_PREFIX.length, separator);
      if (!IV_HEX.test(ivHex)) {
        return null;
      }
      counter = new aesjs.Counter(aesjs.utils.hex.toBytes(ivHex));
      ciphertextHex = value.slice(separator + 1);
    } else {
      // Written by the pre-#12 adapter, whose key was fresh per write.
      counter = new aesjs.Counter(1);
      ciphertextHex = value;
    }

    const cipher = new aesjs.ModeOfOperation.ctr(encryptionKey, counter);
    const decryptedBytes = cipher.decrypt(aesjs.utils.hex.toBytes(ciphertextHex));

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
