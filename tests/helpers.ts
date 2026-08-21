// Shared test helpers. Test-only; not part of the production build.

import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import type { WebSocket } from 'ws';

// ─── Express stubs (rateLimit, future middleware tests) ─────────────────

/** Express `Request` stub. Only `socket.remoteAddress`: all `rateLimit` reads. */
export const makeReq = (ip = '192.168.1.10'): Request =>
  ({ socket: { remoteAddress: ip } } as unknown as Request);

/**
 * Express `Response` stub. Returns the union so callers can pass it as
 * `Response` and still read `statusCode` / `headers`.
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

/** Express `NextFunction` stub, as a vi mock. */
export const makeNext = () =>
  vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;

// ─── WebSocket stubs (client tests) ─────────────────────────────────────

/**
 * Fake WebSocket. `readyState = 1` is `WebSocket.OPEN`, so client.ts's OPEN
 * check passes without mocking the `ws` module.
 */
export const makeWs = () => {
  const ee = new EventEmitter();
  const send = vi.fn();
  return Object.assign(ee, { readyState: 1, send }) as unknown as
    WebSocket & { send: ReturnType<typeof vi.fn>; emit: EventEmitter['emit'] };
};

/**
 * Push a raw WS message and wait for the handler. Handlers run on a promise
 * queue, so `emit` is not synchronous; turning microtasks drains it.
 * Microtasks, not a timer: fake timers make a timer-based flush hang.
 */
export const push = async (ws: ReturnType<typeof makeWs>, msg: object) => {
  ws.emit('message', JSON.stringify(msg));
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
};

/** Parsed messages sent since construction (or the last `send.mockClear()`). */
export const sent = (ws: ReturnType<typeof makeWs>) =>
  (ws.send as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) =>
    JSON.parse(call[0] as string),
  );

/** Drain microtasks + one macrotask tick so async handlers settle. */
export const flush = () => new Promise<void>((r) => setTimeout(r, 0));

// ─── Logger mock factory ────────────────────────────────────────────────

/**
 * Shared `{ logger, addRedaction }` mock shape. Call it inside the closure:
 * vi.mock hoists above imports, so passing the reference directly TDZ-errors.
 *
 *   vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());
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

// ─── Media factory ──────────────────────────────────────────────────────

/**
 * Real `Media` with required fields defaulted, so tests need no partial cast
 * and a newly required field fails them instead of passing silently.
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
