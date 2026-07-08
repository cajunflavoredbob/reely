import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { rateLimit } from '../../internal/app/reely/middleware/rateLimit';
import { makeReq, makeRes, makeNext } from '../helpers';

describe('rateLimit middleware', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets requests through up to the limit', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 3, name: 'test' });
    const next = makeNext();
    for (let i = 0; i < 3; i++) {
      const res = makeRes();
      mw(makeReq(), res, next);
      expect(res.statusCode).toBe(200);
    }
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('returns 429 with Retry-After when over the limit', () => {
    const mw = rateLimit({ windowMs: 30_000, max: 2 });
    const next = makeNext();
    // Burn through the budget.
    mw(makeReq(), makeRes(), next);
    mw(makeReq(), makeRes(), next);
    // Next request should be denied.
    const res = makeRes();
    mw(makeReq(), res, next);
    expect(res.statusCode).toBe(429);
    expect(res.send).toHaveBeenCalledWith('Too many requests');
    // The makeRes helper exposes a captured `headers` field on the
    // returned Response; the union type covers it but the rule
    // doesn't accept the access without a cast.
    // biome-ignore lint/suspicious/noExplicitAny: helper-exposed captured headers.
    expect((res as any).headers['retry-after']).toBeDefined();
    // Should be roughly windowMs/1000 (30) at most.
    // biome-ignore lint/suspicious/noExplicitAny: helper-exposed captured headers.
    const ra = Number((res as any).headers['retry-after']);
    expect(ra).toBeGreaterThan(0);
    expect(ra).toBeLessThanOrEqual(30);
  });

  it('resets the bucket after windowMs elapses', () => {
    const mw = rateLimit({ windowMs: 10_000, max: 1 });
    const next = makeNext();
    mw(makeReq(), makeRes(), next);
    const denied = makeRes();
    mw(makeReq(), denied, next);
    expect(denied.statusCode).toBe(429);
    // Advance past the window.
    vi.advanceTimersByTime(10_001);
    const allowed = makeRes();
    mw(makeReq(), allowed, next);
    expect(allowed.statusCode).toBe(200);
  });

  it('tracks distinct IPs independently', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const next = makeNext();
    const aRes = makeRes();
    mw(makeReq('10.0.0.1'), aRes, next);
    expect(aRes.statusCode).toBe(200);
    const bRes = makeRes();
    mw(makeReq('10.0.0.2'), bRes, next);
    expect(bRes.statusCode).toBe(200);
    // Second hit on the same IP gets 429.
    const aDenied = makeRes();
    mw(makeReq('10.0.0.1'), aDenied, next);
    expect(aDenied.statusCode).toBe(429);
  });

  it('uses "unknown" key when the socket address is missing', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });
    const next = makeNext();
    // Two requests with no socket address share the 'unknown' bucket.
    const noAddr = () => ({ socket: {} } as unknown as Request);
    const a = makeRes();
    mw(noAddr(), a, next);
    expect(a.statusCode).toBe(200);
    const b = makeRes();
    mw(noAddr(), b, next);
    expect(b.statusCode).toBe(429);
  });
});
