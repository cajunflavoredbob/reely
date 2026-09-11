import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { WebSocketServer } from 'ws';

import { loggerMockFactory, makeWs } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: vi.fn(),
}));

import {
  isOriginAllowed,
  createWsUpgradeHandler,
} from '../../internal/app/reely/handlers/api';
import { getConfig } from '../../internal/app/reely/config/main';
import { resetAuthFailureThrottle } from '../../internal/app/reely/middleware/authFailureThrottle';

const mockedGetConfig = vi.mocked(getConfig);

// Only headers are read.
const req = (headers: Record<string, string>): IncomingMessage =>
  ({ headers } as unknown as IncomingMessage);

describe('isOriginAllowed (CSWSH guard)', () => {
  beforeEach(() => {
    // The global clearMocks resets call history but not a mockReturnValue set
    // by a prior test, so it would leak into the next one.
    mockedGetConfig.mockReset();
    mockedGetConfig.mockReturnValue({ allowedOrigins: [] } as never);
  });

  it('allows a request with no Origin header (non-browser client)', () => {
    expect(isOriginAllowed(req({ host: 'reely.lan:8000' }))).toBe(true);
  });

  it('allows a same-origin request (Origin host matches Host)', () => {
    expect(
      isOriginAllowed(req({ host: 'reely.lan:8000', origin: 'http://reely.lan:8000' })),
    ).toBe(true);
  });

  it('rejects a cross-origin request not on the allowlist', () => {
    expect(
      isOriginAllowed(req({ host: 'reely.lan:8000', origin: 'http://evil.example.com' })),
    ).toBe(false);
  });

  it('allows a cross-origin request whose Origin is in allowedOrigins', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['https://reely.example.com'] } as never,
    );
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(true);
  });

  it('rejects a malformed Origin header', () => {
    expect(
      isOriginAllowed(req({ host: 'reely.lan:8000', origin: 'not a url' })),
    ).toBe(false);
  });

  // The spelling an operator gets by copying out of a browser address bar.
  // A raw string compare 403s every handshake and the log tells them to set
  // the variable they already set.
  it('allows an allowlist entry written with a trailing slash', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['https://reely.example.com/'] } as never,
    );
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(true);
  });

  it('allows an allowlist entry whose host differs only in case', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['https://Reely.Example.COM'] } as never,
    );
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(true);
  });

  it('allows an allowlist entry carrying the scheme default port', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['https://reely.example.com:443'] } as never,
    );
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(true);
  });

  // Normalizing must widen only the spellings of a configured origin, never
  // the set of origins.
  it('still rejects a different scheme, host or port', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['https://reely.example.com'] } as never,
    );
    for (const origin of [
      'http://reely.example.com',
      'https://reely.example.com:8443',
      'https://evil.example.com',
      'https://reely.example.com.evil.example.com',
    ]) {
      expect(
        isOriginAllowed(req({ host: 'internal:8000', origin })),
        `${origin} must not be allowed`,
      ).toBe(false);
    }
  });

  // A scheme with no real origin serializes to the literal "null", which must
  // never be treated as a match on either side of the compare.
  it('rejects an opaque origin even if the allowlist holds one too', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: ['file:///srv/reely'] } as never,
    );
    expect(
      isOriginAllowed(req({ host: 'internal:8000', origin: 'file:///srv/reely' })),
    ).toBe(false);
  });

  // The env loader always yields a list, but the natural YAML spelling is a
  // scalar and used to be dropped without a word.
  it('accepts allowedOrigins given as a bare string', () => {
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: 'https://reely.example.com' } as never,
    );
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(true);
  });

  it('rejects everything cross-origin when allowedOrigins is unset', () => {
    mockedGetConfig.mockReturnValue({} as never);
    expect(
      isOriginAllowed(
        req({ host: 'internal:8000', origin: 'https://reely.example.com' }),
      ),
    ).toBe(false);
  });
});

// ─── WS upgrade handler ─────────────────────────────────────────────────

// The upgrade path never touches Express, so nothing the basic_auth or
// rateLimit middleware tests cover applies to it. Driven here with a stub wss
// and a fake socket.

const BASIC_AUTH = { userName: 'reely', password: 'correct-horse' };
const validCredentials = `Basic ${Buffer.from(
  `${BASIC_AUTH.userName}:${BASIC_AUTH.password}`,
).toString('base64')}`;

// Socket stub. The EventEmitter serves the `close` listener the handler
// registers to release its slot.
const makeSocket = (remoteAddress: string) => {
  const emitter = new EventEmitter();
  const written: string[] = [];
  return Object.assign(emitter, {
    remoteAddress,
    write: vi.fn((chunk: string) => { written.push(chunk); return true; }),
    destroy: vi.fn(),
    written,
    // The status line is all any assertion here needs.
    status: () => written.join('').split('\r\n')[0],
  });
};

type FakeSocket = ReturnType<typeof makeSocket>;

// WebSocketServer stub. `accept` false models a handshake ws itself rejects,
// where the upgrade callback never runs.
const makeWss = (accept = true) => {
  const sockets: ReturnType<typeof makeWs>[] = [];
  const emit = vi.fn();
  const handleUpgrade = vi.fn(
    (
      _req: IncomingMessage,
      _socket: unknown,
      _head: Buffer,
      cb: (ws: ReturnType<typeof makeWs>) => void,
    ) => {
      if (!accept) return;
      const ws = makeWs();
      sockets.push(ws);
      cb(ws);
    },
  );
  return { handleUpgrade, emit, sockets } as unknown as WebSocketServer & {
    handleUpgrade: typeof handleUpgrade;
    emit: typeof emit;
    sockets: ReturnType<typeof makeWs>[];
  };
};

const upgradeReq = (
  url = '/api/ws',
  headers: Record<string, string> = {},
): IncomingMessage => ({ url, headers } as unknown as IncomingMessage);

// wsConnectionsByIp is module scope and there is no reset hook, so each case
// uses addresses no other case touches.
let ipCounter = 0;
const freshIp = (): string => {
  ipCounter += 1;
  return `192.0.2.${ipCounter}`;
};

describe('createWsUpgradeHandler: routing and rejection', () => {
  beforeEach(() => {
    mockedGetConfig.mockReset();
    mockedGetConfig.mockReturnValue({ allowedOrigins: [] } as never);
    resetAuthFailureThrottle();
  });

  it('404s a path that is not /api/ws without consulting ws', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    createWsUpgradeHandler(wss)(
      upgradeReq('/api/rooms'),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.status()).toBe('HTTP/1.1 404 Not Found');
    expect(socket.destroy).toHaveBeenCalled();
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('ignores the query string when matching the path', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    createWsUpgradeHandler(wss)(
      upgradeReq('/api/ws?room=abc'),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(wss.handleUpgrade).toHaveBeenCalled();
  });

  it('403s a disallowed Origin', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    createWsUpgradeHandler(wss)(
      upgradeReq('/api/ws', {
        host: 'reely.lan:8000',
        origin: 'http://evil.example.com',
      }),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.status()).toBe('HTTP/1.1 403 Forbidden');
    expect(socket.destroy).toHaveBeenCalled();
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('completes the upgrade and emits connection on the happy path', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    const req = upgradeReq();
    createWsUpgradeHandler(wss)(req, socket as unknown as Socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalled();
    expect(wss.emit).toHaveBeenCalledWith('connection', wss.sockets[0], req);
    expect(socket.destroy).not.toHaveBeenCalled();
  });
});

describe('createWsUpgradeHandler: Basic Auth', () => {
  beforeEach(() => {
    mockedGetConfig.mockReset();
    mockedGetConfig.mockReturnValue(
      { allowedOrigins: [], basicAuth: BASIC_AUTH } as never,
    );
    resetAuthFailureThrottle();
  });

  // The upgrade bypasses Express, so the HTTP middleware's credential check
  // never runs here: without this branch an unauthenticated peer gets a
  // socket on a password-protected deployment.
  it('401s an upgrade with no credentials', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    createWsUpgradeHandler(wss)(
      upgradeReq(),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.status()).toBe('HTTP/1.1 401 Unauthorized');
    expect(socket.written.join('')).toContain('WWW-Authenticate: Basic');
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('401s an upgrade with wrong credentials', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    createWsUpgradeHandler(wss)(
      upgradeReq('/api/ws', {
        authorization: `Basic ${Buffer.from('reely:wrong').toString('base64')}`,
      }),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.status()).toBe('HTTP/1.1 401 Unauthorized');
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('completes the upgrade with correct credentials', () => {
    const wss = makeWss();
    const socket = makeSocket(freshIp());
    createWsUpgradeHandler(wss)(
      upgradeReq('/api/ws', { authorization: validCredentials }),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(wss.handleUpgrade).toHaveBeenCalled();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  // Shares the HTTP middleware's budget, so failed handshakes are metered
  // rather than an unlimited guessing channel.
  it('429s once the shared failure budget is exhausted, even for valid credentials', () => {
    const ip = freshIp();
    const handler = createWsUpgradeHandler(makeWss());
    for (let i = 0; i < 10; i += 1) {
      handler(upgradeReq(), makeSocket(ip) as unknown as Socket, Buffer.alloc(0));
    }

    const wss = makeWss();
    const socket = makeSocket(ip);
    createWsUpgradeHandler(wss)(
      upgradeReq('/api/ws', { authorization: validCredentials }),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(socket.status()).toBe('HTTP/1.1 429 Too Many Requests');
    expect(socket.written.join('')).toMatch(/Retry-After: \d+/);
    expect(wss.handleUpgrade).not.toHaveBeenCalled();
  });

  it('leaves the budget alone when no Basic Auth is configured', () => {
    mockedGetConfig.mockReturnValue({ allowedOrigins: [] } as never);
    const ip = freshIp();
    const wss = makeWss();
    for (let i = 0; i < 15; i += 1) {
      createWsUpgradeHandler(wss)(
        upgradeReq(),
        makeSocket(ip) as unknown as Socket,
        Buffer.alloc(0),
      );
    }
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(15);
  });
});

describe('createWsUpgradeHandler: per-IP slot accounting', () => {
  beforeEach(() => {
    mockedGetConfig.mockReset();
    mockedGetConfig.mockReturnValue({ allowedOrigins: [] } as never);
    resetAuthFailureThrottle();
  });

  // A slot leak is invisible until the cap is reached, at which point the
  // household is locked out of WebSockets until the process restarts.
  it('refuses the 21st concurrent upgrade from one key and recovers as sockets close', () => {
    const ip = freshIp();
    const wss = makeWss();
    const handler = createWsUpgradeHandler(wss);
    const sockets: FakeSocket[] = [];
    for (let i = 0; i < 20; i += 1) {
      const socket = makeSocket(ip);
      sockets.push(socket);
      handler(upgradeReq(), socket as unknown as Socket, Buffer.alloc(0));
    }
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(20);

    const refused = makeSocket(ip);
    handler(upgradeReq(), refused as unknown as Socket, Buffer.alloc(0));
    expect(refused.status()).toBe('HTTP/1.1 429 Too Many Requests');
    expect(refused.destroy).toHaveBeenCalled();
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(20);

    // A different key is unaffected: the cap is per source, not global.
    const other = makeSocket(freshIp());
    handler(upgradeReq(), other as unknown as Socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(21);

    // Closing one frees exactly one slot.
    wss.sockets[0].emit('close');
    const admitted = makeSocket(ip);
    handler(upgradeReq(), admitted as unknown as Socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(22);
    expect(admitted.destroy).not.toHaveBeenCalled();

    // Clean up so the shared Map does not carry into later cases.
    for (const ws of wss.sockets) ws.emit('close');
    for (const socket of sockets) socket.emit('close');
  });

  // ws rejects a malformed handshake itself, and then the upgrade callback
  // never runs: without the socket-level listener the slot stays burned and
  // 20 bad handshakes lock the source out for the life of the process.
  it('releases the slot when ws never completes the handshake', () => {
    const ip = freshIp();
    const rejecting = makeWss(false);
    const handler = createWsUpgradeHandler(rejecting);
    for (let i = 0; i < 25; i += 1) {
      const socket = makeSocket(ip);
      handler(upgradeReq(), socket as unknown as Socket, Buffer.alloc(0));
      socket.emit('close');
    }
    expect(rejecting.handleUpgrade).toHaveBeenCalledTimes(25);

    const wss = makeWss();
    const socket = makeSocket(ip);
    createWsUpgradeHandler(wss)(
      upgradeReq(),
      socket as unknown as Socket,
      Buffer.alloc(0),
    );
    expect(wss.handleUpgrade).toHaveBeenCalled();
    socket.emit('close');
  });

  // Both registrations call the same releaseSlot, so a socket that closes and
  // then errors must not hand back a slot it never held.
  it('releases a slot at most once across the socket and ws listeners', () => {
    const ip = freshIp();
    const wss = makeWss();
    const handler = createWsUpgradeHandler(wss);
    const socket = makeSocket(ip);
    handler(upgradeReq(), socket as unknown as Socket, Buffer.alloc(0));

    socket.emit('close');
    wss.sockets[0].emit('close');
    wss.sockets[0].emit('error', new Error('teardown'));

    // Double release would drive the count negative and let a 21st through.
    for (let i = 0; i < 20; i += 1) {
      handler(upgradeReq(), makeSocket(ip) as unknown as Socket, Buffer.alloc(0));
    }
    const refused = makeSocket(ip);
    handler(upgradeReq(), refused as unknown as Socket, Buffer.alloc(0));
    expect(refused.status()).toBe('HTTP/1.1 429 Too Many Requests');

    for (const ws of wss.sockets) ws.emit('error', new Error('cleanup'));
  });

  // Last in the file on purpose: it fills the shared tracking Map to its cap,
  // so anything running after it would be refused until the cleanup at the end
  // releases the slots again.
  it('refuses only untracked sources once the tracking Map is at its cap', () => {
    const wss = makeWss();
    const handler = createWsUpgradeHandler(wss);
    const sockets: FakeSocket[] = [];
    let refusedAt = -1;
    // clientKey groups IPv4 by exact address, so each of these is its own key.
    // Earlier cases leave entries behind, so find the boundary rather than
    // assuming the Map starts empty.
    for (let i = 0; i < 1200 && refusedAt < 0; i += 1) {
      const socket = makeSocket(`10.0.${Math.floor(i / 250)}.${i % 250}`);
      sockets.push(socket);
      handler(upgradeReq(), socket as unknown as Socket, Buffer.alloc(0));
      if (socket.destroy.mock.calls.length > 0) refusedAt = i;
    }
    expect(refusedAt).toBeGreaterThan(0);
    expect(sockets[refusedAt].status()).toBe('HTTP/1.1 429 Too Many Requests');

    // Evicting to make room would lose the slot accounting for live sockets,
    // so an already-tracked source keeps getting through.
    const before = wss.handleUpgrade.mock.calls.length;
    const tracked = makeSocket('10.0.0.0');
    handler(upgradeReq(), tracked as unknown as Socket, Buffer.alloc(0));
    expect(wss.handleUpgrade).toHaveBeenCalledTimes(before + 1);

    for (const socket of sockets) socket.emit('close');
    tracked.emit('close');
  });
});
