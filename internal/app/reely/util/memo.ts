/**
 * Memoization utilities.
 *
 * memo / memo1 / memo1TTL are production-only: in development they re-execute
 * so code changes land without a restart. Tests that exercise the cache need
 * `vi.stubEnv('NODE_ENV', 'production')`. cachePromise is always active.
 *
 * TTLs across the app differ by design; each cache picks what its data
 * tolerates.
 */

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Single-slot Promise cache with optional TTL. Concurrent callers share one
 * in-flight promise; a rejection clears the slot so an outage recovers on the
 * next call. Active in every env, unlike memo().
 *
 *   const cache = cachePromise(() => doExpensiveAsync(), 60_000);
 */
export const cachePromise = <T>(
  fn: () => Promise<T>,
  ttlMs?: number,
): { get(): Promise<T> } => {
  let promise: Promise<T> | undefined;
  let at = 0;
  return {
    get() {
      const now = Date.now();
      if (!promise || (ttlMs !== undefined && now - at > ttlMs)) {
        at = now;
        const pending = fn();
        promise = pending;
        // Only clear the slot if it still holds this promise: a late rejection
        // from a TTL-expired generation would otherwise discard the newer
        // promise that replaced it, and the next caller would start a second
        // fetch against the upstream that is already struggling.
        pending.catch(() => { if (promise === pending) promise = undefined; });
      }
      return promise;
    },
  };
};

// Distinguishes "not yet computed" from a legitimately cached `undefined`.
const UNSET: unique symbol = Symbol('memo-unset');

/**
 * Caches the **first** call's result; later calls ignore their arguments and
 * return it. For one-time init where args don't vary. Use `memo1` / `memo1TTL`
 * for arg-keyed caching. A cached Promise that rejects clears the cache.
 * Identity function outside production.
 */
export const memo = <T, A extends unknown[]>(fn: (...args: A) => T): (...args: A) => T => {
  if (!isProduction) return fn;

  let cachedResult: T | typeof UNSET = UNSET;
  return (...args: A) => {
    if (cachedResult === UNSET) {
      cachedResult = fn(...args);
      if (cachedResult instanceof Promise) {
        (cachedResult as Promise<unknown>).catch(() => { cachedResult = UNSET; });
      }
    }
    return cachedResult as T;
  };
};

/**
 * Memoizes on the first string argument, expiring after ttlMs. FIFO-bounded so
 * a caller-influenced key (Accept-Language reaching loadTranslation) can't
 * exhaust memory; Map iteration order makes keys().next() the oldest entry.
 * A rejected Promise is evicted so a retry doesn't get the cached rejection.
 */
export const memo1TTL = <T, A extends unknown[]>(
  fn: (key: string, ...rest: A) => T,
  ttlMs: number,
  maxEntries = 64,
): ((key: string, ...rest: A) => T) => {
  if (!isProduction) return fn;

  const cache = new Map<string, { result: T; expiresAt: number }>();
  return (key: string, ...rest: A) => {
    const entry = cache.get(key);
    if (entry && Date.now() < entry.expiresAt) return entry.result;
    // Sweep on every miss. Without it the only release path is a repeat request
    // for the same key, so a key nobody asks for again pins its value (whole
    // Media[] library snapshots, for getMediaCached) until the process exits.
    // The map is capped at maxEntries, so the scan is cheap; an Infinity expiry
    // (the memo1 alias) is never swept.
    const sweepAt = Date.now();
    for (const [cachedKey, cached] of cache) {
      if (sweepAt >= cached.expiresAt) cache.delete(cachedKey);
    }
    // Refreshing an existing key replaces it in place: no growth, nothing to evict.
    if (!cache.has(key) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const result = fn(key, ...rest);
    // Infinity (the memo1 alias) means the hit check always holds: no expiry.
    const expiresAt = ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
    cache.set(key, { result, expiresAt });
    if (result instanceof Promise) {
      // A refresh may have replaced this promise before it rejected.
      (result as Promise<unknown>).catch(() => {
        if (cache.get(key)?.result === result) cache.delete(key);
      });
    }
    return result;
  };
};

/**
 * memo1TTL with no expiration. FIFO eviction still bounds memory.
 */
export const memo1 = <T, A extends unknown[]>(
  fn: (key: string, ...rest: A) => T,
  maxEntries = 64,
): ((key: string, ...rest: A) => T) =>
  memo1TTL(fn, Number.POSITIVE_INFINITY, maxEntries);
