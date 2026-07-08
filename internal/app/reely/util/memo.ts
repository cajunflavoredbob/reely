/**
 * Memoization utilities.
 *
 * Caching is only active in production (NODE_ENV=production). In development,
 * functions always re-execute so code changes are reflected immediately without
 * restarting the server. Test suites that exercise the cache should
 * `vi.stubEnv('NODE_ENV', 'production')`.
 *
 * Cache strategies catalog (audit 12 #277):
 *   - memo / memo1 / memo1TTL    in this file (config-reload-naive, dev passthrough)
 *   - cachePromise                in this file (single-slot in-flight Promise + optional TTL)
 *   - applyRedactions             in logger.ts (regex rebuilt on next addRedaction)
 *   - getMediaCached              in providers/plex.ts (memo1TTL, 5min)
 *   - getLibraries (provider)     in providers/plex.ts (cachePromise, 1h)
 *   - getCapabilities/getServerId in plex/api.ts (cachePromise, no TTL)
 *   - loadTranslation             in i18n.ts (memo1, keyed by input locale)
 *   - getRoom                     in roomStore.ts (Map-backed; not a memo)
 *
 * Inconsistent by design: each cache picks the TTL its data tolerates. The
 * helpers above let new cache sites pick the closest fit instead of growing
 * yet another ad-hoc pattern.
 */

const isProduction = process.env.NODE_ENV === 'production';

/**
 * Single-slot Promise cache with optional TTL (audit 12 #191). Deduplicates
 * the "cache the in-flight Promise; clear on failure" idiom that previously
 * appeared inline in PlexApi.getCapabilities, PlexApi.getServerId, and the
 * provider getLibraries -- three near-identical blocks that drifted
 * independently.
 *
 *   const cache = cachePromise(() => doExpensiveAsync(), 60_000);
 *   cache.get();   // first call fires fn(); concurrent calls share the promise
 *   cache.get();   // within ttlMs: reuses; past ttlMs: re-fires
 *
 * Failed promises clear the slot so a transient outage can recover on the
 * next call. Active in all envs (no production-only gate like memo()).
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
        promise = fn();
        promise.catch(() => { promise = undefined; });
      }
      return promise;
    },
  };
};

// Sentinel for "not yet computed" so a memoized function that legitimately
// returns `undefined` doesn't re-execute on every call (audit 9 #113).
// `typeof UNSET` produces a unique nominal type the cache cell can hold.
const UNSET: unique symbol = Symbol('memo-unset');

/**
 * Memoizes a function, caching the result of the **first** call only. Every
 * subsequent call returns the cached value regardless of arguments. Useful
 * for one-time initialization (e.g. `getVersion`, `loadIndex`) where args
 * don't vary in practice.
 *
 * For arg-keyed memoization, use `memo1` or `memo1TTL`.
 *
 * Failure handling: if the cached value is a Promise that rejects, the cache
 * is cleared so the next call re-executes the function.
 *
 * Note: in non-production (`NODE_ENV !== 'production'`) this is the
 * identity function -- every call re-executes -- so hot-reloaded
 * dev work picks up changes without restart. Production-only memoization
 * is by deliberate choice; not all callers want first-call caching.
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
 * Memoizes a function keyed on its first string argument, expiring entries
 * after ttlMs. Bounded with FIFO eviction so an attacker who can influence
 * the key (e.g. Accept-Language headers feeding loadTranslation) can't
 * exhaust memory. Map iteration order is insertion order in JS, so the
 * first key returned by keys().next() is the oldest entry.
 *
 * Failure handling: if the memoized function returns a Promise that rejects,
 * the entry is removed from the cache so a retry doesn't get the cached
 * rejection. Only evicts on rejection if this exact promise is still cached
 * -- a refresh may have replaced it before this one rejected.
 *
 * For TTL-less caching, use `memo1` below (a thin wrapper passing Infinity
 * as the TTL).
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
    // Skip eviction when we're refreshing an entry that's already in the
    // cache (expired or otherwise) -- the .set() below replaces it in
    // place, so there's no net size growth and evicting an unrelated key
    // would be wasteful.
    if (!cache.has(key) && cache.size >= maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    const result = fn(key, ...rest);
    // Pre-compute expiresAt: when ttlMs is Infinity (the memo1 alias),
    // Date.now() + Infinity is Infinity, so the cache-hit comparison
    // `Date.now() < Infinity` always holds -- effectively no expiry.
    const expiresAt = ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs;
    cache.set(key, { result, expiresAt });
    if (result instanceof Promise) {
      // Only evict on rejection if this exact promise is still the cached entry
      // -- a refresh may have replaced it before this one rejected.
      (result as Promise<unknown>).catch(() => {
        if (cache.get(key)?.result === result) cache.delete(key);
      });
    }
    return result;
  };
};

/**
 * Memoizes a function keyed on its first string argument with no expiration
 * (audit 15 #381 consolidated this with memo1TTL -- they shared ~80% logic
 * and the only difference was the TTL check). FIFO eviction at maxEntries
 * still bounds memory; rejected Promises are evicted from the cache.
 */
export const memo1 = <T, A extends unknown[]>(
  fn: (key: string, ...rest: A) => T,
  maxEntries = 64,
): ((key: string, ...rest: A) => T) =>
  memo1TTL(fn, Number.POSITIVE_INFINITY, maxEntries);
