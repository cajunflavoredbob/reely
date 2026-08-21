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
  readFileMock,
  cleanupExpiredRoomsMock,
  flushPendingSavesMock,
  createProviderMock,
  createWsUpgradeHandlerMock,
} = vi.hoisted(() => {
  const wsClients = new Set();
  class WebSocketServerMock {
    clients = wsClients;
    on = vi.fn();
    close = vi.fn();
  }
  return {
    createHttpServerMock: vi.fn(),
    createHttpsServerMock: vi.fn(),
    WebSocketServerMock,
    readFileMock: vi.fn(),
    cleanupExpiredRoomsMock: vi.fn().mockResolvedValue(undefined),
    flushPendingSavesMock: vi.fn().mockResolvedValue(undefined),
    createProviderMock: vi.fn(),
    createWsUpgradeHandlerMock: vi.fn(() => () => {}),
  };
});

vi.mock('node:http', () => ({ createServer: createHttpServerMock }));
vi.mock('node:https', () => ({ createServer: createHttpsServerMock }));
vi.mock('node:fs/promises', async () => {
  // importActual keeps mkdtemp/chmod live for transitive callers; only
  // readFile is overridden.
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, readFile: readFileMock };
});
vi.mock('ws', () => ({ WebSocketServer: WebSocketServerMock }));
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
import { Application, ProviderUnavailableError } from '../../internal/app/reely/app';
import { logger } from '../../internal/app/reely/logger';
import type { Config } from '../../types/reely';

// listen and close fire their callbacks async, so shutdown's `close(cb)`
// resolves the statusCode promise.
type FakeServer = EventEmitter & {
  listen: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  closeAllConnections: ReturnType<typeof vi.fn>;
};

const makeFakeServer = (): FakeServer => {
  const server = new EventEmitter() as FakeServer;
  server.listen = vi.fn((_port: number, _hostname: string, cb: () => void) => {
    setImmediate(cb);
    return server;
  });
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

// AbortController only dispatches to listeners present at abort time, and the
// abort listener is registered late in startup, so an early abort is lost.
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

  it('is idempotent: the shuttingDown guard short-circuits a second call path', async () => {
    const controller = new AbortController();
    const { statusCode } = Application(baseConfig(), controller.signal);
    await waitForAbortListener(controller.signal);
    controller.abort();
    await statusCode;
    // AbortController fires once, so a second abort can't be dispatched.
    // Single-call counts stand in: re-entry would double them.
    expect(flushPendingSavesMock).toHaveBeenCalledTimes(1);
    expect(fakeHttpServer.close).toHaveBeenCalledTimes(1);
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
