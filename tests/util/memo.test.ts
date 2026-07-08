import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('memo (dev mode)', () => {
  // In non-production environments memo/memo1 are pass-through -- no caching.
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

  // Audit 9 #113: the prior cache cell was `T | undefined` and the miss
  // check was `cachedResult === undefined`, so a function that legitimately
  // returned `undefined` would re-execute on every call. 0.4.5 switched to
  // a sentinel symbol -- this test exercises that exact case.
  it('caches a function that returns undefined (audit 9 #113 sentinel)', async () => {
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
    expect(first).toBe(second); // cached -- same string
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
