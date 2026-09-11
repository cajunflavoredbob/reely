import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('memo (dev mode)', () => {
  // Outside production, memo and memo1 are pass-through.
  it('calls fn every invocation', async () => {
    const { memo } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn(() => 42);
    const memoized = memo(fn);
    memoized();
    memoized();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('memo1 calls fn for every invocation regardless of key', async () => {
    const { memo1 } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn((key: string) => key.toUpperCase());
    const memoized = memo1(fn);
    memoized('a');
    memoized('a');
    memoized('b');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('memo (production mode)', () => {
  beforeEach(() => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('calls fn only once and returns cached result', async () => {
    const { memo } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn(() => 99);
    const memoized = memo(fn);
    expect(memoized()).toBe(99);
    expect(memoized()).toBe(99);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  // A `=== undefined` miss check re-executes a function that legitimately
  // returns undefined, hence the sentinel.
  it('caches a function that returns undefined', async () => {
    const { memo } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn(() => undefined as unknown as number);
    const memoized = memo(fn);
    expect(memoized()).toBeUndefined();
    expect(memoized()).toBeUndefined();
    expect(memoized()).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('memo1 caches per key', async () => {
    const { memo1 } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn((key: string) => key.toUpperCase());
    const memoized = memo1(fn);
    expect(memoized('a')).toBe('A');
    expect(memoized('a')).toBe('A');
    expect(memoized('b')).toBe('B');
    expect(fn).toHaveBeenCalledTimes(2); // once per unique key
  });

  it('memo1 returns cached value on repeated key calls', async () => {
    const { memo1 } = await import('../../internal/app/reely/util/memo');
    let callCount = 0;
    const fn = vi.fn((key: string) => { callCount++; return `${key}-${callCount}`; });
    const memoized = memo1(fn);
    const first = memoized('x');
    const second = memoized('x');
    expect(first).toBe(second); // cached: same string
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('memo1TTL recomputes once the entry expires', async () => {
    vi.useFakeTimers();
    try {
      const { memo1TTL } = await import('../../internal/app/reely/util/memo');
      const fn = vi.fn((key: string) => key.toUpperCase());
      const memoized = memo1TTL(fn, 1000);
      memoized('a');
      vi.advanceTimersByTime(999);
      memoized('a');
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      memoized('a');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // The bound exists because loadTranslation is keyed on an unauthenticated
  // Accept-Language string, so the key space is caller-influenced.
  it('memo1TTL evicts the oldest entry past maxEntries', async () => {
    const { memo1TTL } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn((key: string) => key.toUpperCase());
    const memoized = memo1TTL(fn, 60_000, 2);
    memoized('a');
    memoized('b');
    memoized('c');       // evicts 'a'
    expect(fn).toHaveBeenCalledTimes(3);
    memoized('c');       // still cached
    memoized('b');       // still cached
    expect(fn).toHaveBeenCalledTimes(3);
    memoized('a');       // gone: recomputed
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('memo1TTL refreshes an existing key in place without evicting another', async () => {
    vi.useFakeTimers();
    try {
      const { memo1TTL } = await import('../../internal/app/reely/util/memo');
      const fn = vi.fn((key: string) => key.toUpperCase());
      const memoized = memo1TTL(fn, 1000, 2);
      memoized('a');
      memoized('b');
      vi.advanceTimersByTime(1001);
      memoized('a');     // expired, recomputed, replaces itself
      expect(fn).toHaveBeenCalledTimes(3);
      // 'b' is expired too but must still be present as an entry, not evicted
      // by the refresh of 'a'.
      memoized('b');
      expect(fn).toHaveBeenCalledTimes(4);
      memoized('a');
      expect(fn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  // Without eviction, one outage is cached for the whole TTL and every retry
  // gets the same rejection back.
  it('memo1TTL evicts a rejected promise so the next call retries', async () => {
    const { memo1TTL } = await import('../../internal/app/reely/util/memo');
    let attempts = 0;
    const fn = vi.fn(async (key: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error('boom');
      return key.toUpperCase();
    });
    const memoized = memo1TTL(fn, 60_000);
    await expect(memoized('a')).rejects.toThrow('boom');
    await expect(memoized('a')).resolves.toBe('A');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('memo1TTL keeps a resolved promise cached', async () => {
    const { memo1TTL } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn(async (key: string) => key.toUpperCase());
    const memoized = memo1TTL(fn, 60_000);
    await expect(memoized('a')).resolves.toBe('A');
    await expect(memoized('a')).resolves.toBe('A');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// cachePromise is active in every environment, unlike memo/memo1/memo1TTL.
describe('cachePromise', () => {
  it('shares one in-flight promise across concurrent callers', async () => {
    const { cachePromise } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn(async () => 'value');
    const cache = cachePromise(fn);
    const [a, b] = [cache.get(), cache.get()];
    expect(a).toBe(b);
    expect(await a).toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('keeps returning the resolved value with no TTL', async () => {
    const { cachePromise } = await import('../../internal/app/reely/util/memo');
    const fn = vi.fn(async () => 'value');
    const cache = cachePromise(fn);
    await cache.get();
    await cache.get();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('refetches once the TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      const { cachePromise } = await import('../../internal/app/reely/util/memo');
      let n = 0;
      const fn = vi.fn(async () => { n += 1; return n; });
      const cache = cachePromise(fn, 1000);
      await expect(cache.get()).resolves.toBe(1);
      vi.advanceTimersByTime(500);
      await expect(cache.get()).resolves.toBe(1);
      vi.advanceTimersByTime(1001);
      await expect(cache.get()).resolves.toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // A cached rejection would pin an outage for the life of the process on the
  // no-TTL caches (PlexApi capabilities, serverId, sections).
  it('clears the slot on rejection so the next call retries', async () => {
    const { cachePromise } = await import('../../internal/app/reely/util/memo');
    let n = 0;
    const fn = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error('offline');
      return 'recovered';
    });
    const cache = cachePromise(fn);
    await expect(cache.get()).rejects.toThrow('offline');
    await expect(cache.get()).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
