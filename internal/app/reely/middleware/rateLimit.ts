import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';

// Fixed-window per-IP rate limiter. Lightweight, in-memory; no external dep.
//
// Keyed on req.socket.remoteAddress -- the real TCP peer -- NOT req.ip.
// req.ip is derived from the client-controllable X-Forwarded-For header when
// Express `trust proxy` is enabled, which would let an attacker mint a fresh
// bucket per forged IP and defeat the limiter. The socket address can't be
// spoofed. Behind a reverse proxy this is the proxy's address, so the limiter
// becomes a global throttle -- still a useful flood backstop, and fine for
// reely's typical LAN/Unraid deployment.

interface Bucket {
  count: number;
  resetAt: number;
}

interface RateLimitOptions {
  windowMs: number;
  max: number;
  name?: string;
}

// Upper bound on the per-route bucket Map so a flood of distinct source IPs
// can't exhaust memory. Eviction is FIFO via Map insertion order.
const MAX_BUCKETS = 2048;

export const rateLimit = ({ windowMs, max, name }: RateLimitOptions) => {
  const buckets = new Map<string, Bucket>();

  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();

    // Opportunistic cleanup when the bucket cache is full (audit 14
    // #360). Two passes, separated for clarity:
    //   1. Expired-bucket sweep: drop every entry whose window has
    //      already elapsed. Cheap, and usually enough to free space.
    //   2. Oldest-bucket eviction: if the sweep didn't bring us under
    //      the cap (e.g. a flood of fresh distinct IPs), drop the
    //      single oldest entry by insertion order (Map iteration order
    //      is insertion order in JS).
    // The previous single combined loop was correct but read like an
    // off-by-one; splitting makes each pass's intent obvious.
    if (buckets.size >= MAX_BUCKETS) {
      // Pass 1: drop expired entries
      for (const [k, b] of buckets) {
        if (b.resetAt < now) buckets.delete(k);
      }
      // Pass 2: if still over the cap, evict the single oldest
      if (buckets.size >= MAX_BUCKETS) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
    }

    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      logger.warn(
        `rate limit hit${name ? ` (${name})` : ''}: ip=${key} ${bucket.count}/${max} in ${windowMs}ms`,
      );
      res.status(429).send('Too many requests');
      return;
    }

    next();
  };
};
