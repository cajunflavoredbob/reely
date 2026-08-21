import { logger } from '../logger';

// Fixed-window per-IP throttle for FAILED Basic Auth attempts. The per-route
// limiters count every request, so they can't tell a legitimate user from an
// online brute force of the only access gate, and they don't cover the WS
// upgrade at all. Counts 401 outcomes only, shared by the Express middleware
// and the WS upgrade handler so switching vectors doesn't reset the budget.
//
// Keyed on the socket peer for the same non-spoofability reason as
// rateLimit.ts. Behind a proxy it degrades to a global failed-auth backstop.

const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;

// Bounds the Map so a flood of distinct source IPs can't exhaust memory.
const MAX_BUCKETS = 2048;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Seconds until this IP's window resets once its budget is exhausted (for
// Retry-After), or 0 when the request may proceed to the credential check.
export const authFailureRetryAfter = (ip: string, now = Date.now()): number => {
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now || bucket.count < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
};

export const recordAuthFailure = (ip: string, now = Date.now()): void => {
  // Opportunistic cleanup when full: expired sweep, then oldest eviction.
  if (buckets.size >= MAX_BUCKETS) {
    for (const [k, b] of buckets) {
      if (b.resetAt < now) buckets.delete(k);
    }
    if (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (oldest !== undefined) buckets.delete(oldest);
    }
  }
  let bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count === MAX_FAILURES) {
    logger.warn(
      `Basic Auth failure budget exhausted for ${ip} ` +
        `(${MAX_FAILURES} failures in ${WINDOW_MS}ms); throttling until window reset`,
    );
  }
};

// Test hook: state is module-scoped so HTTP and WS share one budget, which
// means tests need an explicit reset between cases.
export const resetAuthFailureThrottle = (): void => {
  buckets.clear();
};
