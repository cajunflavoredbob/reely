import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn(),
}));

// Declared before the SUT import: the handler's import chain pulls the logger
// in during initialization.
import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { checkBasicAuth, handler } from '../../internal/app/reely/handlers/basic_auth';
import {
  authFailureRetryAfter,
  recordAuthFailure,
  resetAuthFailureThrottle,
} from '../../internal/app/reely/middleware/authFailureThrottle';
import { getConfig } from '../../internal/app/reely/config/main';
import type { BasicAuth } from '../../types/reely';

const creds: BasicAuth = { userName: 'admin', password: 's3cret' };
// base64 of "admin:s3cret".
const token = Buffer.from('admin:s3cret').toString('base64');

describe('checkBasicAuth', () => {
  it('accepts a well-formed header', () => {
    expect(checkBasicAuth(creds, `Basic ${token}`)).toBe(true);
  });

  // RFC 7617: the auth-scheme is case-insensitive.
  it('accepts a lowercased scheme', () => {
    expect(checkBasicAuth(creds, `basic ${token}`)).toBe(true);
  });

  it('tolerates surrounding and extra inter-token whitespace', () => {
    expect(checkBasicAuth(creds, `  Basic   ${token}  `)).toBe(true);
  });

  it('rejects the wrong password', () => {
    const bad = Buffer.from('admin:wrong').toString('base64');
    expect(checkBasicAuth(creds, `Basic ${bad}`)).toBe(false);
  });

  it('rejects a non-Basic scheme', () => {
    expect(checkBasicAuth(creds, `Bearer ${token}`)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(checkBasicAuth(creds, undefined)).toBe(false);
  });

  // Empty configured credentials must never authenticate, even against a
  // matching empty-password header.
  it('fails closed when the configured password is empty', () => {
    const emptyPw = { userName: 'admin', password: '' };
    const header = `Basic ${Buffer.from('admin:').toString('base64')}`;
    expect(checkBasicAuth(emptyPw, header)).toBe(false);
  });
});

// Failed attempts are throttled per IP so the only access gate cannot be
// brute-forced at line rate. The budget is module-scoped (shared with the WS
// upgrade handler), so tests reset it explicitly.
const mockedGetConfig = vi.mocked(getConfig);

const makeReq = (authorization?: string, ip = '10.0.0.1') =>
  ({
    headers: { authorization },
    socket: { remoteAddress: ip },
    method: 'GET',
    path: '/',
  }) as unknown as Parameters<typeof handler>[0];

const makeRes = () => {
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    setHeader: vi.fn((k: string, v: string) => {
      res.headers[k] = v;
    }),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: vi.fn(() => res),
    end: vi.fn(() => res),
  };
  return res as unknown as Parameters<typeof handler>[1] & typeof res;
};

describe('failed-auth throttle', () => {
  beforeEach(() => {
    resetAuthFailureThrottle();
    mockedGetConfig.mockReturnValue({
      basicAuth: creds,
      servers: [],
    } as unknown as ReturnType<typeof getConfig>);
  });

  afterEach(() => {
    resetAuthFailureThrottle();
    vi.useRealTimers();
  });

  it('answers failures with 401 until the budget is exhausted, then 429', () => {
    const next = vi.fn();
    for (let i = 0; i < 10; i++) {
      const res = makeRes();
      handler(makeReq('Basic d3Jvbmc='), res, next);
      expect(res.statusCode).toBe(401);
    }
    const res = makeRes();
    handler(makeReq('Basic d3Jvbmc='), res, next);
    expect(res.statusCode).toBe(429);
    expect(res.headers['Retry-After']).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  it('throttles even CORRECT credentials once the budget is exhausted (lockout)', () => {
    const next = vi.fn();
    for (let i = 0; i < 10; i++) {
      handler(makeReq('Basic d3Jvbmc='), makeRes(), next);
    }
    const res = makeRes();
    handler(makeReq(`Basic ${token}`), res, next);
    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it('successful auth does not consume failure budget', () => {
    const next = vi.fn();
    for (let i = 0; i < 20; i++) {
      handler(makeReq(`Basic ${token}`), makeRes(), next);
    }
    expect(next).toHaveBeenCalledTimes(20);
    expect(authFailureRetryAfter('10.0.0.1')).toBe(0);
  });

  it('tracks budgets per IP', () => {
    const next = vi.fn();
    for (let i = 0; i < 10; i++) {
      handler(makeReq('Basic d3Jvbmc=', '10.0.0.1'), makeRes(), next);
    }
    // The flooded IP is throttled, another is not.
    expect(authFailureRetryAfter('10.0.0.1')).toBeGreaterThan(0);
    const res = makeRes();
    handler(makeReq(`Basic ${token}`, '10.0.0.2'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('the window resets after 60s', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    for (let i = 0; i < 10; i++) recordAuthFailure('10.0.0.9');
    expect(authFailureRetryAfter('10.0.0.9')).toBeGreaterThan(0);
    vi.setSystemTime(61_000);
    expect(authFailureRetryAfter('10.0.0.9')).toBe(0);
  });
});
