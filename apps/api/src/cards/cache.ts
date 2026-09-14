// The cards cache: an in-process LRU with stale-while-revalidate, single-flight loads, and an
// injected clock. design.md "The cards cache" owns the contract and the pinned defaults.
//
// An own module and not a dependency: the adapter around `lru-cache` plus a test clock is this
// size, and the repository's stance is that swapping the cache layer should touch one module —
// which the `CardsCache` interface below is for. Keep Drizzle and Bun-only imports out of it.

/** What the service reads through: a value per key, loaded by the caller's loader when it must be. */
export interface CardsCache<V> {
  /**
   * The value for `key`: a fresh entry as it is; a stale one as it is, with one revalidation
   * started behind it; otherwise the result of `load`, shared with every concurrent caller of
   * the same key. A load that throws rejects every waiter and leaves no entry.
   */
  get(key: string, load: () => Promise<V>): Promise<V>;
}

export const CARDS_CACHE_ENV_NAMES = {
  enabled: 'CARDS_CACHE',
  freshMs: 'CARDS_CACHE_FRESH_MS',
  staleMs: 'CARDS_CACHE_STALE_MS',
  maxEntries: 'CARDS_CACHE_MAX_ENTRIES',
} as const;

export type CardsCacheConfig = {
  /** `CARDS_CACHE=off` makes the module a pass-through: every read is a query (design.md). */
  enabled: boolean;
  /** The age since load below which an entry is served without a query. */
  freshMs: number;
  /**
   * The age since load below which an entry is still served, one revalidation behind it; at
   * this age or older it is expired. An age since load, not a length past `freshMs`.
   */
  staleMs: number;
  /** The LRU bound on keys. */
  maxEntries: number;
};

/**
 * design.md "The cards cache" pins these. In a measured run the freshness window is longer than
 * the fan-out, so the stale path never runs there; the tests are what prove it.
 */
export const CARDS_CACHE_DEFAULTS: CardsCacheConfig = {
  enabled: true,
  freshMs: 60_000,
  staleMs: 600_000,
  maxEntries: 64,
};

function readPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function readSwitch(
  env: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new Error(`${name} must be "on" or "off", got "${raw}"`);
}

/** Refuse a window the states cannot be told apart in, rather than serving from one nobody meant. */
export function validateCardsCacheConfig(config: CardsCacheConfig): CardsCacheConfig {
  if (config.freshMs > config.staleMs) {
    throw new Error(
      `${CARDS_CACHE_ENV_NAMES.freshMs} must not exceed ${CARDS_CACHE_ENV_NAMES.staleMs}, ` +
        `got ${config.freshMs} > ${config.staleMs}`,
    );
  }
  return config;
}

export function readCardsCacheConfig(env: Record<string, string | undefined>): CardsCacheConfig {
  return validateCardsCacheConfig({
    enabled: readSwitch(env, CARDS_CACHE_ENV_NAMES.enabled, CARDS_CACHE_DEFAULTS.enabled),
    freshMs: readPositiveInt(env, CARDS_CACHE_ENV_NAMES.freshMs, CARDS_CACHE_DEFAULTS.freshMs),
    staleMs: readPositiveInt(env, CARDS_CACHE_ENV_NAMES.staleMs, CARDS_CACHE_DEFAULTS.staleMs),
    maxEntries: readPositiveInt(
      env,
      CARDS_CACHE_ENV_NAMES.maxEntries,
      CARDS_CACHE_DEFAULTS.maxEntries,
    ),
  });
}

/** One line for a process's start line, beside the sink's. */
export function describeCardsCache(config: CardsCacheConfig): string {
  if (!config.enabled) return 'cards cache off';
  return (
    `cards cache on fresh=${config.freshMs}ms stale=${config.staleMs}ms ` +
    `max_entries=${config.maxEntries}`
  );
}

export type SwrCacheOptions = Pick<CardsCacheConfig, 'freshMs' | 'staleMs' | 'maxEntries'> & {
  /** Milliseconds on a monotonic clock; a test's is whatever the test says it is. */
  clock: () => number;
};

type Entry<V> = { value: V; loadedAt: number };

/**
 * A `Map` in insertion order is the LRU: a hit re-inserts its key at the end, and an insert past
 * `maxEntries` removes the key at the front. Ages are read off the injected clock, so fresh,
 * stale and expired are decided without a timer. One in-flight load per key is the single-flight:
 * a cold key under a batch of 25 concurrent sends costs one query, and a stale key under the same
 * batch starts one revalidation.
 */
export function createSwrCache<V>({
  freshMs,
  staleMs,
  maxEntries,
  clock,
}: SwrCacheOptions): CardsCache<V> {
  if (!(maxEntries >= 1)) throw new Error(`maxEntries must be at least 1, got ${maxEntries}`);
  if (!(freshMs >= 0) || !(staleMs >= freshMs)) {
    throw new Error(`expected 0 <= freshMs <= staleMs, got ${freshMs}..${staleMs}`);
  }
  const entries = new Map<string, Entry<V>>();
  const inFlight = new Map<string, Promise<V>>();

  const touch = (key: string, entry: Entry<V>) => {
    entries.delete(key);
    entries.set(key, entry);
  };

  const store = (key: string, value: V) => {
    touch(key, { value, loadedAt: clock() });
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  // The one load per key. A loader that throws synchronously rejects like one that rejects.
  const load = (key: string, loader: () => Promise<V>): Promise<V> => {
    const running = inFlight.get(key);
    if (running) return running;
    const promise = (async () => loader())().then(
      (value) => {
        inFlight.delete(key);
        store(key, value);
        return value;
      },
      (error: unknown) => {
        inFlight.delete(key);
        throw error;
      },
    );
    inFlight.set(key, promise);
    return promise;
  };

  return {
    get(key, loader) {
      const entry = entries.get(key);
      if (entry) {
        const age = clock() - entry.loadedAt;
        if (age < freshMs) {
          touch(key, entry);
          return Promise.resolve(entry.value);
        }
        if (age < staleMs) {
          touch(key, entry);
          // One revalidation behind the stale value; a second stale hit starts nothing. Its
          // failure is nobody's here — the stale entry stays for the next hit to try again — so
          // it is caught rather than left to reject unobserved.
          if (!inFlight.has(key)) load(key, loader).catch(() => {});
          return Promise.resolve(entry.value);
        }
        entries.delete(key);
      }
      return load(key, loader);
    },
  };
}

/** `CARDS_CACHE=off`: every read is a query, which is what part 3's control run measures. */
export function createPassThroughCache<V>(): CardsCache<V> {
  return {
    get(_key, loader) {
      return loader();
    },
  };
}

/** The cache a process reads through, by its configuration. */
export function createCardsCache<V>(
  config: CardsCacheConfig,
  clock: () => number = () => performance.now(),
): CardsCache<V> {
  if (!config.enabled) return createPassThroughCache<V>();
  const { freshMs, staleMs, maxEntries } = validateCardsCacheConfig(config);
  return createSwrCache<V>({ freshMs, staleMs, maxEntries, clock });
}
