import { describe, expect, it } from 'bun:test';

import {
  CARDS_CACHE_DEFAULTS,
  createCardsCache,
  createPassThroughCache,
  createSwrCache,
  describeCardsCache,
  readCardsCacheConfig,
  type CardsCache,
} from './cache';

/** A clock the test moves by hand, so fresh, stale and expired are decided without a timer. */
function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

/** A loader that counts its calls and answers with the call number, or throws on demand. */
function countingLoader(fail?: () => Error | undefined) {
  let calls = 0;
  const load = async () => {
    calls += 1;
    const error = fail?.();
    if (error) throw error;
    return `value-${calls}`;
  };
  return { load, calls: () => calls };
}

/** A loader whose promise the test settles, so the in-flight state can be observed. */
function gatedLoader() {
  const settle: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  const load = () =>
    new Promise<string>((resolve, reject) => {
      settle.push({ resolve, reject });
    });
  return { load, settle, calls: () => settle.length };
}

const options = (clock: () => number) => ({ freshMs: 100, staleMs: 1_000, maxEntries: 3, clock });

describe('createSwrCache', () => {
  it('awaits the loader for an absent key and serves the value it returned', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = countingLoader();

    expect(await cache.get('2026-09-15', loader.load)).toBe('value-1');
    expect(loader.calls()).toBe(1);
  });

  it('serves a fresh hit without calling the loader', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = countingLoader();
    await cache.get('k', loader.load);

    clock.advance(99);
    expect(await cache.get('k', loader.load)).toBe('value-1');
    expect(loader.calls()).toBe(1);
  });

  it('serves a stale hit as it is and calls the loader once behind it', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = countingLoader();
    await cache.get('k', loader.load);

    clock.advance(100);
    // Stale: the old value comes back at once, and one revalidation starts.
    expect(await cache.get('k', loader.load)).toBe('value-1');
    // A second stale hit while it runs starts nothing.
    expect(await cache.get('k', loader.load)).toBe('value-1');
    expect(loader.calls()).toBe(2);
    // Once the revalidation has landed, the new value is served, fresh again.
    await Bun.sleep(0);
    expect(await cache.get('k', loader.load)).toBe('value-2');
    expect(loader.calls()).toBe(2);
  });

  it('awaits the loader for an expired key rather than serving the old value', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = countingLoader();
    await cache.get('k', loader.load);

    clock.advance(1_000);
    expect(await cache.get('k', loader.load)).toBe('value-2');
    expect(loader.calls()).toBe(2);
  });

  it('shares one in-flight load between twenty-five concurrent gets of a cold key', async () => {
    // Single-flight: a cold cache under a batch of 25 concurrent sends costs one query.
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = gatedLoader();

    const gets = Array.from({ length: 25 }, () => cache.get('2026-09-15', loader.load));
    expect(loader.calls()).toBe(1);
    loader.settle[0]?.resolve('the day');

    expect(await Promise.all(gets)).toEqual(Array.from({ length: 25 }, () => 'the day'));
    expect(loader.calls()).toBe(1);
    // And the entry is now fresh: no further load.
    expect(await cache.get('2026-09-15', loader.load)).toBe('the day');
    expect(loader.calls()).toBe(1);
  });

  it('keeps single-flight per key, so two dates in one batch cost two queries and not one', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = gatedLoader();

    const gets = [
      cache.get('2026-09-15', loader.load),
      cache.get('2026-09-16', loader.load),
      cache.get('2026-09-15', loader.load),
    ];
    expect(loader.calls()).toBe(2);
    loader.settle[0]?.resolve('the 15th');
    loader.settle[1]?.resolve('the 16th');

    expect(await Promise.all(gets)).toEqual(['the 15th', 'the 16th', 'the 15th']);
  });

  it('rejects every waiter of a failed load and leaves no entry', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = gatedLoader();

    const gets = Array.from({ length: 5 }, () => cache.get('k', loader.load));
    loader.settle[0]?.reject(new Error('connection refused'));
    for (const get of gets) await expect(get).rejects.toThrow('connection refused');

    // Nothing was stored, so the next get loads again rather than reading a failure.
    const next = cache.get('k', loader.load);
    expect(loader.calls()).toBe(2);
    loader.settle[1]?.resolve('recovered');
    expect(await next).toBe('recovered');
  });

  it('keeps a stale entry when its revalidation fails, and tries again on the next stale hit', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    let fail = false;
    const loader = countingLoader(() => (fail ? new Error('replica gone') : undefined));
    await cache.get('k', loader.load);

    clock.advance(100);
    fail = true;
    expect(await cache.get('k', loader.load)).toBe('value-1');
    await Bun.sleep(0);
    // The failed revalidation left the old value in place and raised nothing here; this stale hit
    // starts the next one.
    expect(await cache.get('k', loader.load)).toBe('value-1');
    expect(loader.calls()).toBe(3);
    fail = false;
    await Bun.sleep(0);
    // Still stale, so the old value again, with a revalidation that now succeeds behind it...
    expect(await cache.get('k', loader.load)).toBe('value-1');
    expect(loader.calls()).toBe(4);
    await Bun.sleep(0);
    // ...and the next hit reads what it loaded.
    expect(await cache.get('k', loader.load)).toBe('value-4');
    expect(loader.calls()).toBe(4);
  });

  it('rejects a loader that throws synchronously the same way', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));

    await expect(
      cache.get('k', () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');
  });

  it('evicts the least recently used key past maxEntries', async () => {
    const clock = fakeClock();
    const cache = createSwrCache<string>(options(clock.now));
    const loader = countingLoader();
    await cache.get('a', loader.load);
    await cache.get('b', loader.load);
    await cache.get('c', loader.load);
    // A hit on `a` makes `b` the least recently used.
    await cache.get('a', loader.load);
    expect(loader.calls()).toBe(3);

    await cache.get('d', loader.load);
    expect(loader.calls()).toBe(4);

    // `b` is gone and loads again; `a`, `c` and `d` are still fresh.
    await cache.get('a', loader.load);
    await cache.get('c', loader.load);
    await cache.get('d', loader.load);
    expect(loader.calls()).toBe(4);
    await cache.get('b', loader.load);
    expect(loader.calls()).toBe(5);
  });

  it('refuses a window it cannot tell the states apart in', () => {
    const clock = fakeClock();
    expect(() => createSwrCache({ ...options(clock.now), maxEntries: 0 })).toThrow(/maxEntries/);
    expect(() => createSwrCache({ ...options(clock.now), freshMs: 2_000 })).toThrow(
      /freshMs <= staleMs/,
    );
    // Equal windows are allowed: there is then no stale state, only fresh and expired.
    expect(() => createSwrCache({ ...options(clock.now), freshMs: 1_000 })).not.toThrow();
  });
});

describe('createPassThroughCache', () => {
  it('calls the loader on every get, which is what CARDS_CACHE=off measures', async () => {
    const cache: CardsCache<string> = createPassThroughCache();
    const loader = countingLoader();

    expect(await cache.get('k', loader.load)).toBe('value-1');
    expect(await cache.get('k', loader.load)).toBe('value-2');
    expect(loader.calls()).toBe(2);
  });
});

describe('readCardsCacheConfig', () => {
  it('uses the defaults design.md pins when nothing is set', () => {
    expect(readCardsCacheConfig({})).toEqual({
      enabled: true,
      freshMs: 60_000,
      staleMs: 600_000,
      maxEntries: 64,
    });
    expect(readCardsCacheConfig({ CARDS_CACHE: '', CARDS_CACHE_FRESH_MS: '' })).toEqual(
      CARDS_CACHE_DEFAULTS,
    );
  });

  it('reads every CARDS_CACHE* variable', () => {
    expect(
      readCardsCacheConfig({
        CARDS_CACHE: 'on',
        CARDS_CACHE_FRESH_MS: '5000',
        CARDS_CACHE_STALE_MS: '30000',
        CARDS_CACHE_MAX_ENTRIES: '8',
      }),
    ).toEqual({ enabled: true, freshMs: 5_000, staleMs: 30_000, maxEntries: 8 });
  });

  it('turns the module into a pass-through with off, and refuses anything else', () => {
    expect(readCardsCacheConfig({ CARDS_CACHE: 'off' }).enabled).toBe(false);
    expect(() => readCardsCacheConfig({ CARDS_CACHE: 'false' })).toThrow(
      'CARDS_CACHE must be "on" or "off", got "false"',
    );
    expect(() => readCardsCacheConfig({ CARDS_CACHE: 'ON' })).toThrow('CARDS_CACHE must be');
  });

  it('refuses a value that is not a positive integer, naming the variable', () => {
    expect(() => readCardsCacheConfig({ CARDS_CACHE_FRESH_MS: '0' })).toThrow(
      'CARDS_CACHE_FRESH_MS must be a positive integer, got "0"',
    );
    expect(() => readCardsCacheConfig({ CARDS_CACHE_STALE_MS: '1.5' })).toThrow(
      'CARDS_CACHE_STALE_MS',
    );
    expect(() => readCardsCacheConfig({ CARDS_CACHE_MAX_ENTRIES: 'many' })).toThrow(
      'CARDS_CACHE_MAX_ENTRIES',
    );
    expect(() => readCardsCacheConfig({ CARDS_CACHE_MAX_ENTRIES: '-1' })).toThrow(
      'CARDS_CACHE_MAX_ENTRIES',
    );
  });

  it('refuses a freshness window longer than the stale one', () => {
    expect(() =>
      readCardsCacheConfig({ CARDS_CACHE_FRESH_MS: '2000', CARDS_CACHE_STALE_MS: '1000' }),
    ).toThrow('CARDS_CACHE_FRESH_MS must not exceed CARDS_CACHE_STALE_MS, got 2000 > 1000');
    expect(() =>
      readCardsCacheConfig({ CARDS_CACHE_FRESH_MS: '1000', CARDS_CACHE_STALE_MS: '1000' }),
    ).not.toThrow();
  });
});

describe('createCardsCache', () => {
  it('is the SWR cache when on and the pass-through when off', async () => {
    const loader = countingLoader();
    const on = createCardsCache<string>(CARDS_CACHE_DEFAULTS, () => 0);
    await on.get('k', loader.load);
    await on.get('k', loader.load);
    expect(loader.calls()).toBe(1);

    const off = createCardsCache<string>({ ...CARDS_CACHE_DEFAULTS, enabled: false });
    await off.get('k', loader.load);
    await off.get('k', loader.load);
    expect(loader.calls()).toBe(3);
  });
});

describe('describeCardsCache', () => {
  it('names the setting for a start line', () => {
    expect(describeCardsCache(CARDS_CACHE_DEFAULTS)).toBe(
      'cards cache on fresh=60000ms stale=600000ms max_entries=64',
    );
    expect(describeCardsCache({ ...CARDS_CACHE_DEFAULTS, enabled: false })).toBe('cards cache off');
  });
});
