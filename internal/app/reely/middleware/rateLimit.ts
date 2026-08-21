import type { Request, Response, NextFunction } from 'express';
import { logger } from '../logger';
import { clientKey } from '../util/clientKey';

// Fixed-window per-IP rate limiter, in-memory.
//
// Keyed on the socket peer, never req.ip: under `trust proxy`, req.ip comes
// from client-controlled X-Forwarded-For and would let an attacker mint a
// fresh bucket per forged IP. Behind a real proxy the peer is the proxy, so
// this degrades to a global throttle: still a useful flood backstop.

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
    // Grouped like every other per-source cap (see util/clientKey): a raw
    // IPv6 address is per-connection, not per-client.
    const key = clientKey(req.socket.remoteAddress);
    const now = Date.now();

    // Opportunistic cleanup when full: sweep expired buckets, then fall back
    // to evicting the oldest if a flood of fresh IPs kept us over the cap.
    if (buckets.size >= MAX_BUCKETS) {
      for (const [k, b] of buckets) {
        if (b.resetAt < now) buckets.delete(k);
      }
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
