// Shared test helpers (audit 9 #125). Each helper was previously inline in
// the one test file that used it; centralizing them gives a single place
// to widen / fix the stub shapes when a future test wants the same scaffold.
// Only consumed from `tests/**`; not part of the production build.

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { WebSocket } from 'ws';

// ─── Express stubs (rateLimit, future middleware tests) ─────────────────

/**
 * Minimal Express `Request` stub. Only `socket.remoteAddress` is populated
 * because `rateLimit` -- the current sole consumer -- keys off it. Widen
 * with additional headers/path/method as new callers need them.
 */
export const makeReq = (ip = '192.168.1.10'): Request =>
  ({ socket: { remoteAddress: ip } } as unknown as Request);

/**
 * Minimal Express `Response` stub. `setHeader`/`status`/`send` are mocked;
 * `statusCode` + a captured `headers` map are surfaced for assertions.
 * Returns the union so callers can both pass it to middleware (as
 * `Response`) and inspect the recorded state.
 */
export const makeRes = () => {
  const headers: Record<string, string> = {};
  const r = {
    statusCode: 200,
    setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; }),
    status: vi.fn(function (this: typeof r, code: number) { this.statusCode = code; return this; }),
    send: vi.fn(),
    headers,
  };
  return r as unknown as Response & typeof r;
};

/** Minimal Express `NextFunction` stub returned as a vi mock. */
export const makeNext = () =>
  vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;

// ─── WebSocket stubs (client tests) ─────────────────────────────────────

/**
 * Minimal fake WebSocket: EventEmitter + readyState + send.
 * `readyState = 1` matches `WebSocket.OPEN` from the real `ws` package, so
 * `client.ts`'s `this.ws.readyState !== WebSocket.OPEN` check works without
 * mocking the `ws` module.
 */
export const makeWs = () => {
  const ee = new EventEmitter();
  const send = vi.fn();
  return Object.assign(ee, { readyState: 1, send }) as unknown as
    WebSocket & { send: ReturnType<typeof vi.fn>; emit: EventEmitter['emit'] };
};

/** Push a raw WS message into the fake client. */
export const push = (ws: ReturnType<typeof makeWs>, msg: object) =>
  ws.emit('message', JSON.stringify(msg));

/**
 * Return all parsed messages sent by the client since construction (or the
 * last `mockClear()` on its `send`).
 */
export const sent = (ws: ReturnType<typeof makeWs>) =>
  (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) =>
    JSON.parse(call[0] as string),
  );

/** Drain microtasks + one macrotask tick so async handlers settle. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ─── Logger mock factory (audit 12 #269) ────────────────────────────────

/**
 * Factory for the `{ logger: {...}, addRedaction }` mock shape used by 11+
 * test files. Use via a closure so the factory reference resolves at
 * mock-call time (vi.mock is hoisted above imports; passing
 * `loggerMockFactory` directly would TDZ-error before the import
 * completes):
 *
 *   import { loggerMockFactory } from '../helpers';
 *   vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());
 *
 * One source of truth; if the logger surface grows a new level, callers
 * pick up the new mock function automatically.
 */
export const loggerMockFactory = () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
  addRedaction: vi.fn(),
});

// ─── Media factory (audit 12 #196) ──────────────────────────────────────

/**
 * Build a Media-shaped object with every required field defaulted, so
 * tests that previously cast `{ id, title, type }` partials can construct
 * a real `Media` without the cast. A tightening of the runtime shape
 * (e.g. a new required field) now fails the test by missing the default
 * instead of silently passing because the consumer only read `.id`.
 *
 * Optional fields (year, posterUrl, duration, rating, contentRating,
 * tagline) stay undefined unless the caller overrides them.
 */
export const makeMedia = (overrides: Partial<{
  id: string;
  type: 'movie';
  title: string;
  description: string;
  tagline: string;
  year: number;
  posterUrl: string;
  plexKey: string;
  genres: string[];
  duration: number;
  rating: number;
  contentRating: string;
}> = {}) => ({
  id: 'media-1',
  type: 'movie' as const,
  title: 'Example Film',
  description: '',
  plexKey: '/library/metadata/1',
  genres: [],
  ...overrides,
});
