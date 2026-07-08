import { logger } from '../logger';

// Fixed-window per-IP throttle for FAILED Basic Auth attempts (audit 16
// #425). The general per-route limiters count every request, so they can't
// separate a legitimate authenticated user from an online brute force of
// the only access gate -- and they don't cover the WS upgrade path at all.
// This module counts only 401 outcomes and is shared between the Express
// middleware and the WS upgrade handler, so switching vectors doesn't
// reset the budget.
//
// Keyed on socket.remoteAddress -- the real TCP peer -- for the same
// non-spoofability reason as rateLimit.ts. Behind a reverse proxy this is
// the proxy's address, so the throttle becomes a global failed-auth
// backstop; a legitimate user's typo behind the same proxy costs them one
// unit of the shared budget, which the generous cap absorbs.

const WINDOW_MS = 60_000;
const MAX_FAILURES = 10;

// Upper bound on the bucket Map so a flood of distinct source IPs can't
// exhaust memory (same rationale + shape as rateLimit.ts MAX_BUCKETS).
const MAX_BUCKETS = 2048;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Seconds until the IP's failure window resets when its budget is
// exhausted (suitable for a Retry-After header), or 0 when the request
// may proceed to the credential check.
export const authFailureRetryAfter = (ip: string, now = Date.now()): number => {
  const bucket = buckets.get(ip);
  if (!bucket || bucket.resetAt < now || bucket.count < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
};

export const recordAuthFailure = (ip: string, now = Date.now()): void => {
  // Opportunistic cleanup when full: expired-bucket sweep, then oldest
  // eviction (Map iteration order is insertion order). Mirrors
  // rateLimit.ts's audit 14 #360 two-pass shape.
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

// Test hook: the window state is module-scoped (deliberately -- HTTP and
// WS must share one budget), so tests need an explicit reset between cases.
export const resetAuthFailureThrottle = (): void => {
  buckets.clear();
};
