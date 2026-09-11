import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loggerMockFactory } from '../helpers';

// Everything below express (net, ws, fs, roomStore, providers, handlers/api)
// is mocked, so startup touches no socket or disk.
//
// vi.hoisted runs before imports resolve, so it holds only vi.fn() handles;
// anything needing an imported symbol is built in beforeEach.
const {
  createHttpServerMock,
  createHttpsServerMock,
  WebSocketServerMock,
  wsServers,
  readFileMock,
  cleanupExpiredRoomsMock,
  flushPendingSavesMock,
  createProviderMock,
  createWsUpgradeHandlerMock,
  helmetMock,
  ClientMock,
} = vi.hoisted(() => {
  // Every instance gets its own `clients` and records the handlers passed to
  // `on`. A shared Set nothing ever populated, plus a no-op `on`, left the
  // 'connection' handler and the liveness reaper unreachable from any test.
  const wsServers: WebSocketServerMock[] = [];
  class WebSocketServerMock {
    clients = new Set<FakeWsClient>();
    handlers = new Map<string, (...args: never[]) => void>();
    close = vi.fn();
    on: ReturnType<typeof vi.fn>;
    constructor() {
      this.on = vi.fn((event: string, cb: (...args: never[]) => void) => {
        this.handlers.set(event, cb);
        return this;
      });
      wsServers.push(this);
    }
  }
  return {
    createHttpServerMock: vi.fn(),
    createHttpsServerMock: vi.fn(),
    WebSocketServerMock,
    wsServers,
    readFileMock: vi.fn(),
    cleanupExpiredRoomsMock: vi.fn().mockResolvedValue(undefined),
    flushPendingSavesMock: vi.fn().mockResolvedValue(undefined),
    createProviderMock: vi.fn(),
    createWsUpgradeHandlerMock: vi.fn(() => () => {}),
    // Real helmet builds middleware that swallows its directives; the mock
    // keeps the CSP options readable from the call args.
    helmetMock: vi.fn((_options?: unknown) =>
      (_req: unknown, _res: unknown, next: () => void) => { next(); }),
    ClientMock: vi.fn(),
  };
});

// Minimal socket shape the app tags, pings and terminates.
type FakeWsClient = {
  readyState: number;
  OPEN: number;
  isAlive?: boolean;
  ping: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  pongHandlers: Array<() => void>;
};

const makeFakeWsClient = (): FakeWsClient => {
  const pongHandlers: Array<() => void> = [];
  return {
    readyState: 1,
    OPEN: 1,
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: string, cb: () => void) => {
      if (event === 'pong') pongHandlers.push(cb);
    }),
    pongHandlers,
  };
};

vi.mock('node:http', () => ({ createServer: createHttpServerMock }));
vi.mock('node:https', () => ({ createServer: createHttpsServerMock }));
vi.mock('node:fs/promises', async () => {
  // importActual keeps mkdtemp/chmod live for transitive callers; only
  // readFile is overridden.
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: readFileMock };
});
vi.mock('ws', () => ({ WebSocketServer: WebSocketServerMock }));
vi.mock('helmet', () => ({ default: helmetMock }));
vi.mock('../../internal/app/reely/client', () => ({ Client: ClientMock }));
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());
vi.mock('../../internal/app/reely/providers/plex', () => ({
  createProvider: createProviderMock,
}));
vi.mock('../../internal/app/reely/roomStore', () => ({
  cleanupExpiredRooms: cleanupExpiredRoomsMock,
  flushPendingSaves: flushPendingSavesMock,
  ROOM_TTL_MS: 6 * 60 * 60 * 1000,
}));
vi.mock('../../internal/app/reely/handlers/api', () => ({
  createWsUpgradeHandler: createWsUpgradeHandlerMock,
}));

// Below the vi.mock calls so mocks are in place at import-bind time.
import { Application, ProviderUnavailableError, describeError } from '../../internal/app/reely/app';
import { logger } from '../../internal/app/reely/logger';
import type { Config } from '../../types/reely';

// listen and close fire their callbacks async, so shutdown's `close(cb)`
// resolves the statusCode promise.
type FakeServer = EventEmitter & {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
  address: ReturnType<typeof vi.fn>;
};

const makeFakeServer = (): FakeServer => {
  const server = new EventEmitter() as FakeServer;
  // Mirrors Node: address() reports what listen() bound, and null before that.
  let bound: { address: string; family: string; port: number } | null = null;
  server.listen = vi.fn((port: number, hostname: string, cb: () => void) => {
    bound = { address: hostname, family: 'IPv4', port };
    setImmediate(cb);
    return server;
  });
  server.address = vi.fn(() => bound);
  server.close = vi.fn((cb?: () => void) => {
    setImmediate(() => cb?.());
    return server;
  });
  server.closeAllConnections = vi.fn();
  return server;
};

let fakeHttpServer: FakeServer;
let fakeHttpsServer: FakeServer;

// Tests override fields per case.
const baseConfig = (): Config =>
  ({
    hostname: '127.0.0.1',
    port: 8000,
    logLevel: 'INFO',
    rootPath: '',
    servers: [],
    exposePlexBaseUrl: true,
    // biome-ignore lint/suspicious/noExplicitAny: missing fields are enforced by the validator, not by app.ts.
  }) as any;

// Only `isAvailable` and `options.url` matter; the rest satisfy the type.
// biome-ignore lint/suspicious/noExplicitAny: partial provider stub.
const makeProviderStub = (opts: { isAvailable?: boolean; url?: string } = {}): any => ({
  type: 'plex',
  options: { url: opts.url ?? 'http://plex.local:32400' },
  isAvailable: vi.fn().mockResolvedValue(opts.isAvailable ?? true),
  isUserAuthorized: vi.fn().mockResolvedValue(true),
  getName: vi.fn().mockResolvedValue('Plex'),
  getServerId: vi.fn().mockResolvedValue('SERVER1'),
  getLibraries: vi.fn().mockResolvedValue([]),
  getFilters: vi.fn().mockResolvedValue({}),
  getFilterValues: vi.fn().mockResolvedValue([]),
  getArtwork: vi.fn(),
  getMedia: vi.fn().mockResolvedValue([]),
});

beforeEach(() => {
  fakeHttpServer = makeFakeServer();
  fakeHttpsServer = makeFakeServer();
  createHttpServerMock.mockReset().mockReturnValue(fakeHttpServer);
  createHttpsServerMock.mockReset().mockReturnValue(fakeHttpsServer);
  readFileMock.mockReset();
  cleanupExpiredRoomsMock.mockClear().mockResolvedValue(undefined);
  flushPendingSavesMock.mockClear().mockResolvedValue(undefined);
  createProviderMock.mockReset();
  createWsUpgradeHandlerMock.mockClear();
  helmetMock.mockClear();
  ClientMock.mockClear();
  wsServers.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Application: provider config branches', () => {
  it('emits no warn when zero servers are configured', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(createProviderMock).not.toHaveBeenCalled();
  });

  // `servers` is an array for future multi-provider support, but multiple
  // servers are not supported today.
  it('warns when more than one server is configured and uses only the first', async () => {
    const config = baseConfig();
    config.servers = [
      { type: 'plex', url: 'http://plex-1', token: 't1' },
      { type: 'plex', url: 'http://plex-2', token: 't2' },
    ];
    createProviderMock.mockReturnValueOnce(makeProviderStub({ url: 'http://plex-1' }));
    Application(config);
    await new Promise((r) => setImmediate(r));
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('2 servers configured'),
    );
    expect(createProviderMock).toHaveBeenCalledTimes(1);
    expect(createProviderMock).toHaveBeenCalledWith('0', expect.objectContaining({ url: 'http://plex-1' }));
  });

  it('rejects (statusCode -> 1) on a non-plex server type', async () => {
    const config = baseConfig();
    // biome-ignore lint/suspicious/noExplicitAny: off-spec type, to reach the runtime guard behind TS.
    config.servers = [{ type: 'emby', url: 'http://emby', token: 't' } as any];
    const { statusCode } = Application(config);
    await expect(statusCode).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('server type emby unhandled'),
    );
  });

  it('rejects with ProviderUnavailableError when the provider isAvailable returns false', async () => {
    const config = baseConfig();
    config.servers = [{ type: 'plex', url: 'http://plex', token: 't' }];
    createProviderMock.mockReturnValueOnce(makeProviderStub({ isAvailable: false }));
    const { statusCode } = Application(config);
    await expect(statusCode).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(statusCode).rejects.toThrow(/Plex server unavailable/);
  });

  // A real outage (refused connection, DNS failure, timeout, bad token) makes
  // isAvailable() throw rather than return false, which used to land on the
  // generic startup-error path and drop the reason.
  it('rejects with ProviderUnavailableError when the provider isAvailable throws', async () => {
    const config = baseConfig();
    config.servers = [{ type: 'plex', url: 'http://plex', token: 't' }];
    const provider = makeProviderStub();
    const cause = new Error('Plex fetch failed after 2 attempts', {
      cause: new Error('connect ECONNREFUSED 10.0.0.9:32400'),
    });
    provider.isAvailable = vi.fn().mockRejectedValue(cause);
    createProviderMock.mockReturnValueOnce(provider);
    const { statusCode } = Application(config);
    await expect(statusCode).rejects.toBeInstanceOf(ProviderUnavailableError);
    await statusCode.catch((err: unknown) => {
      expect((err as Error).cause).toBe(cause);
      // The whole chain survives for the operator, errno included.
      expect(describeError(err)).toContain('ECONNREFUSED');
    });
  });

  // The redaction registry holds the full URL and replaces exact substrings
  // only, so a truncated copy printed unmasked.
  it('names the whole Plex URL in the message, untruncated', async () => {
    const url = 'http://media-server.internal.example.com:32400/plex';
    expect(url.length).toBeGreaterThan(32);
    const config = baseConfig();
    config.servers = [{ type: 'plex', url, token: 't' }];
    createProviderMock.mockReturnValueOnce(makeProviderStub({ isAvailable: false, url }));
    const { statusCode } = Application(config);
    await expect(statusCode).rejects.toThrow(url);
  });
});

describe('Application: content security policy', () => {
  const directivesFromHelmet = () => {
    const [options] = helmetMock.mock.calls[0] ?? [];
    // biome-ignore lint/suspicious/noExplicitAny: reading back the helmet options object.
    return (options as any).contentSecurityPolicy.directives;
  };

  // The browser probes `${plexBaseUrl}/identity` to prefer a direct LAN link,
  // and connect-src 'self' blocks that fetch before it is even sent.
  it('allows the Plex origin in connect-src when the base URL is exposed', async () => {
    const config = baseConfig();
    config.servers = [{ type: 'plex', url: 'http://10.0.0.9:32400/', token: 't' }];
    createProviderMock.mockReturnValueOnce(makeProviderStub());
    Application(config);
    await new Promise((r) => setImmediate(r));
    expect(directivesFromHelmet().connectSrc).toEqual(["'self'", 'http://10.0.0.9:32400']);
  });

  it('keeps connect-src at self when exposePlexBaseUrl is false', async () => {
    const config = baseConfig();
    config.exposePlexBaseUrl = false;
    config.servers = [{ type: 'plex', url: 'http://10.0.0.9:32400', token: 't' }];
    createProviderMock.mockReturnValueOnce(makeProviderStub());
    Application(config);
    await new Promise((r) => setImmediate(r));
    expect(directivesFromHelmet().connectSrc).toEqual(["'self'"]);
  });

  it('keeps connect-src at self when no server is configured', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(directivesFromHelmet().connectSrc).toEqual(["'self'"]);
  });
});

describe('Application: TLS read order', () => {
  // Guards against a bad cert path failing only after express setup, provider
  // probes and the TTL sweep have left state to clean up.
  it('surfaces a TLS readFile failure as statusCode -> 1', async () => {
    const config = baseConfig();
    config.tlsConfig = { certFile: '/nope/cert.pem', keyFile: '/nope/key.pem' };
    readFileMock.mockRejectedValueOnce(new Error('ENOENT: no such file'));
    const { statusCode } = Application(config);
    await expect(statusCode).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startup error'),
    );
  });

  it('does NOT call cleanupExpiredRooms when the TLS read fails (early-exit ordering)', async () => {
    const config = baseConfig();
    config.tlsConfig = { certFile: '/nope/cert.pem', keyFile: '/nope/key.pem' };
    readFileMock.mockRejectedValueOnce(new Error('ENOENT'));
    const { statusCode } = Application(config);
    await statusCode;
    expect(cleanupExpiredRoomsMock).not.toHaveBeenCalled();
  });

  // No TLS: readFile is skipped and startup reaches the sweep.
  it('runs cleanupExpiredRooms on startup when TLS is not configured', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(cleanupExpiredRoomsMock).toHaveBeenCalledTimes(1);
    expect(cleanupExpiredRoomsMock).toHaveBeenCalledWith(6 * 60 * 60 * 1000);
  });
});

describe('Application: bind-all-interfaces warn', () => {
  // Rooms are gated only by knowing the room name, so binding all interfaces
  // without basicAuth is effectively open.
  it.each([['0.0.0.0'], ['::'], ['']])(
    'warns when bound to "%s" without basicAuth',
    async (hostname) => {
      const config = baseConfig();
      config.hostname = hostname;
      Application(config);
      // Wait through the listen callback and its microtasks.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(true);
    },
  );

  it('does NOT warn when bound to all interfaces WITH basicAuth set', async () => {
    const config = baseConfig();
    config.hostname = '0.0.0.0';
    config.basicAuth = { userName: 'admin', password: 'hunter2' };
    Application(config);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(false);
  });

  it('does NOT warn when bound to a specific (non-all-interfaces) hostname', async () => {
    const config = baseConfig();
    config.hostname = '127.0.0.1';
    Application(config);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(false);
  });

  // A bare `hostname:` line in config.yaml parses to null, which listen()
  // treats as "bind everything" while a string comparison stayed quiet.
  it('warns when the configured hostname is null and the socket bound the wildcard', async () => {
    const config = baseConfig();
    // biome-ignore lint/suspicious/noExplicitAny: js-yaml yields null for a valueless key.
    (config as any).hostname = null;
    fakeHttpServer.address = vi.fn(() => ({ address: '::', family: 'IPv6', port: 8000 }));
    Application(config);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(true);
    // And the startup line names an address instead of "null".
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Server listening on http://::'));
  });

  // dns.lookup resolves "0" to 0.0.0.0, as do these other spellings.
  it.each([['0'], ['::0'], ['[::]'], ['::ffff:0.0.0.0']])(
    'warns for the wildcard spelling "%s"',
    async (hostname) => {
      const config = baseConfig();
      config.hostname = hostname;
      Application(config);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const warnCalls = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
      expect(warnCalls.some((m) => typeof m === 'string' && m.includes('Bound to'))).toBe(true);
    },
  );
});

describe('Application: WebSocket connection wiring and liveness reaper', () => {
  const startListening = async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    return wsServers[0];
  };

  it('tags a new socket alive, wires pong, and hands it to a Client', async () => {
    const wss = await startListening();
    const connection = wss.handlers.get('connection');
    expect(connection).toBeTypeOf('function');
    const ws = makeFakeWsClient();
    // biome-ignore lint/suspicious/noExplicitAny: partial ws stub.
    (connection as any)(ws);
    expect(ws.isAlive).toBe(true);
    expect(ClientMock).toHaveBeenCalledTimes(1);
    expect(ClientMock).toHaveBeenCalledWith(ws, []);
    // A pong re-tags a socket the reaper already marked as suspect.
    ws.isAlive = false;
    for (const handler of ws.pongHandlers) handler();
    expect(ws.isAlive).toBe(true);
  });

  it('pings on the first sweep and terminates a socket that missed the pong', async () => {
    // Only the intervals are faked: the startup awaits still need setImmediate.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const wss = await startListening();
    const ws = makeFakeWsClient();
    ws.isAlive = true;
    wss.clients.add(ws);

    vi.advanceTimersByTime(30_000);
    expect(ws.ping).toHaveBeenCalledTimes(1);
    expect(ws.terminate).not.toHaveBeenCalled();
    // The sweep clears the tag; only a pong sets it back.
    expect(ws.isAlive).toBe(false);

    vi.advanceTimersByTime(30_000);
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(ws.ping).toHaveBeenCalledTimes(1);
  });

  it('stops both intervals on shutdown', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const controller = new AbortController();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await waitForAbortListener(controller.signal);
    const ws = makeFakeWsClient();
    wsServers[0].clients.add(ws);
    controller.abort();
    await statusCode;

    ws.ping.mockClear();
    ws.terminate.mockClear();
    cleanupExpiredRoomsMock.mockClear();
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(ws.ping).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
    expect(cleanupExpiredRoomsMock).not.toHaveBeenCalled();
  });
});

describe('Application: HTTP vs HTTPS server selection', () => {
  it('creates a plain HTTP server when no TLS config is provided', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(createHttpServerMock).toHaveBeenCalledTimes(1);
    expect(createHttpsServerMock).not.toHaveBeenCalled();
  });

  it('creates an HTTPS server with the read bundle when TLS config is provided', async () => {
    readFileMock.mockResolvedValueOnce(Buffer.from('CERT'));
    readFileMock.mockResolvedValueOnce(Buffer.from('KEY'));
    const config = baseConfig();
    config.tlsConfig = { certFile: '/etc/cert.pem', keyFile: '/etc/key.pem' };
    Application(config);
    await new Promise((r) => setImmediate(r));
    expect(createHttpsServerMock).toHaveBeenCalledTimes(1);
    expect(createHttpServerMock).not.toHaveBeenCalled();
    const [tlsArg] = createHttpsServerMock.mock.calls[0] ?? [];
    expect(tlsArg).toEqual({ cert: Buffer.from('CERT'), key: Buffer.from('KEY') });
  });
});

// An abort before the server is listening stops startup instead of running the
// full close path, so tests asserting a clean shutdown wait out startup first.
const waitForAbortListener = async (signal: AbortSignal): Promise<void> => {
  // EventTarget exposes no listener count, so the wait is time-based. 50
  // cycles is well past startup's ~6 awaits.
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setImmediate(r));
  }
  void signal; // unused: the wait is time-based
};

describe('Application: shutdown via abort signal', () => {
  it('resolves statusCode to undefined on clean shutdown', async () => {
    const controller = new AbortController();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await waitForAbortListener(controller.signal);
    controller.abort();
    await expect(statusCode).resolves.toBeUndefined();
    expect(flushPendingSavesMock).toHaveBeenCalledTimes(1);
    expect(fakeHttpServer.close).toHaveBeenCalledTimes(1);
    expect(fakeHttpServer.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  // A real AbortController dispatches once, so the guard needs a signal stub
  // whose captured listener can be fired twice.
  it('is idempotent: a second abort dispatch is short-circuited by the guard', async () => {
    let fire: (() => void) | undefined;
    const signal = {
      aborted: false,
      addEventListener: (_type: string, cb: () => void) => { fire = cb; },
    } as unknown as AbortSignal;
    const { statusCode } = Application(baseConfig(), signal);
    await waitForAbortListener(signal);
    expect(fire).toBeTypeOf('function');
    fire?.();
    fire?.();
    await statusCode;
    expect(flushPendingSavesMock).toHaveBeenCalledTimes(1);
    expect(fakeHttpServer.close).toHaveBeenCalledTimes(1);
    expect(fakeHttpServer.closeAllConnections).toHaveBeenCalledTimes(1);
  });

  // Draining while the sockets are still open loses every swipe accepted
  // during the flush: it arms a debounce timer in a queue the flush has
  // already snapshotted and nothing drains it before the process exits.
  it('terminates WebSocket clients before draining the save queue', async () => {
    const controller = new AbortController();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await waitForAbortListener(controller.signal);
    const ws = makeFakeWsClient();
    wsServers[0].clients.add(ws);
    controller.abort();
    await statusCode;
    expect(ws.terminate).toHaveBeenCalledTimes(1);
    expect(wsServers[0].close).toHaveBeenCalledTimes(1);
    expect(ws.terminate.mock.invocationCallOrder[0])
      .toBeLessThan(flushPendingSavesMock.mock.invocationCallOrder[0]);
    expect(wsServers[0].close.mock.invocationCallOrder[0])
      .toBeLessThan(flushPendingSavesMock.mock.invocationCallOrder[0]);
  });

  // The abort listener used to be registered only after listen() resolved, so
  // a stop during a slow Plex probe was dropped and the server booted anyway.
  it('does not start the server when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await expect(statusCode).resolves.toBeUndefined();
    expect(createHttpServerMock).not.toHaveBeenCalled();
    expect(cleanupExpiredRoomsMock).not.toHaveBeenCalled();
  });

  it('stops startup when the abort lands mid-boot, before the server listens', async () => {
    const controller = new AbortController();
    // Abort while the startup TTL sweep is still in flight.
    cleanupExpiredRoomsMock.mockImplementationOnce(async () => {
      controller.abort();
    });
    const { statusCode } = Application(baseConfig(), controller.signal);
    await expect(statusCode).resolves.toBeUndefined();
    expect(createHttpServerMock).not.toHaveBeenCalled();
  });
});

describe('Application: post-listen server errors', () => {
  // listen()'s guard is a `once` on an already-settled promise; without a
  // standing listener the second server error escapes the emitter and kills
  // the process.
  it('logs server errors raised after listen instead of throwing', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(() => {
      fakeHttpServer.emit('error', new Error('EMFILE: too many open files'));
      fakeHttpServer.emit('error', new Error('EMFILE: too many open files'));
    }).not.toThrow();
    const errorCalls = (logger.error as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
    expect(errorCalls.filter((m) => typeof m === 'string' && m.includes('HTTP server error')))
      .toHaveLength(2);
  });
});

describe('Application: WS upgrade wiring', () => {
  it('registers the upgrade handler returned by createWsUpgradeHandler', async () => {
    Application(baseConfig());
    await new Promise((r) => setImmediate(r));
    expect(createWsUpgradeHandlerMock).toHaveBeenCalledTimes(1);
    // Attached via httpServer.on('upgrade', handler).
    expect(fakeHttpServer.listenerCount('upgrade')).toBe(1);
  });
});

describe('Application: generic startup error', () => {
  it('catches a roomStore.cleanupExpiredRooms throw and resolves statusCode to 1', async () => {
    cleanupExpiredRoomsMock.mockRejectedValueOnce(new Error('disk full'));
    const { statusCode } = Application(baseConfig());
    await expect(statusCode).resolves.toBe(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('startup error'),
    );
  });
});
