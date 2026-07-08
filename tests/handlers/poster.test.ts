import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';
import { ReadableStream } from 'node:stream/web';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { handler as posterHandler } from '../../internal/app/reely/handlers/poster';
import type { ReelyProvider } from '../../internal/app/reely/providers/types';

// ─── Stubs ──────────────────────────────────────────────────────────────

// Express-shaped Request stub: only `params` is read by the handler.
const makeReq = (
  params: { providerIndex?: string; metadataId?: string; thumbId?: string },
): Request =>
  ({ params } as unknown as Request);

// Express-shaped Response stub: status/send/setHeader spies, a captured
// headers map, an EventEmitter for `on('close')`, a destroy spy, and a
// `pipe`-target shim so `nodeStream.pipe(res)` doesn't throw. `locals`
// carries the providers array (the route normally injects it via
// middleware -- see app.ts).
const makeRes = (providers: ReelyProvider[]) => {
  const emitter = new EventEmitter();
  const headers: Record<string, string> = {};
  // Track piped chunks for the success-path tests.
  const chunks: Buffer[] = [];
  const r = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    locals: { providers },
    setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; }),
    status: vi.fn(function (this: typeof r, code: number) {
      this.statusCode = code;
      this.headersSent = true;
      return this;
    }),
    send: vi.fn(function (this: typeof r) {
      this.headersSent = true;
      return this;
    }),
    write: vi.fn((chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    }),
    end: vi.fn(),
    destroy: vi.fn(),
    headers,
    chunks,
  });
  // Cast lets the handler treat this as a Response while tests can read
  // the captured spies/headers/chunks directly.
  return r as unknown as Response & typeof r;
};

// Provider factory: getArtwork returns a [ReadableStream, Headers] tuple.
// Tests can override the resolved value or make it reject.
const makeProvider = (overrides: Partial<ReelyProvider> = {}): ReelyProvider =>
  ({
    type: 'plex',
    options: { url: 'http://test:32400' },
    isAvailable: vi.fn().mockResolvedValue(true),
    isUserAuthorized: vi.fn().mockResolvedValue(true),
    getName: vi.fn().mockResolvedValue('Test'),
    getServerId: vi.fn().mockResolvedValue('test-id'),
    getLibraries: vi.fn().mockResolvedValue([]),
    getFilters: vi.fn().mockResolvedValue({ filters: [], filterTypes: {} }),
    getFilterValues: vi.fn().mockResolvedValue([]),
    getMedia: vi.fn().mockResolvedValue([]),
    getArtwork: vi.fn(),
    ...overrides,
  } as unknown as ReelyProvider);

// Build a one-shot Web ReadableStream from a Buffer. Mirrors what
// PlexApi.getRawThumb returns at runtime (a Web-API ReadableStream that
// Readable.fromWeb consumes inside the handler).
const makeStream = (buf: Buffer): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });

// ─── Tests ───────────────────────────────────────────────────────────────

describe('poster handler: param validation', () => {
  let provider: ReelyProvider;
  beforeEach(() => {
    provider = makeProvider();
  });

  // audit 12 #225: `+providerIndex` accepts Infinity / NaN / whitespace
  // strings. Explicit /^\d+$/ rejects them BEFORE coercion.
  it.each(['', 'abc', 'Infinity', 'NaN', '-1', '1.5', ' 0', '0 '])(
    'rejects non-numeric providerIndex %j with 404',
    async (providerIndex) => {
      const req = makeReq({ providerIndex, metadataId: '1', thumbId: '2' });
      const res = makeRes([provider]);
      await posterHandler(req, res);
      expect(res.statusCode).toBe(404);
      expect(res.send).toHaveBeenCalledWith('Provider not found');
      expect(provider.getArtwork).not.toHaveBeenCalled();
    },
  );

  it('rejects out-of-bounds providerIndex with 404', async () => {
    // Single provider at index 0; "1" is out-of-bounds (`providers[1]`
    // is undefined).
    const req = makeReq({ providerIndex: '1', metadataId: '1', thumbId: '2' });
    const res = makeRes([provider]);
    await posterHandler(req, res);
    expect(res.statusCode).toBe(404);
    expect(res.send).toHaveBeenCalledWith('Provider not found');
    expect(provider.getArtwork).not.toHaveBeenCalled();
  });

  // Path-traversal defense: any non-numeric id (including
  // url-encoded `..`) gets rejected before the upstream fetch.
  it.each([
    ['../system', '2'],
    ['1', '../system'],
    ['1', '2/extra'],
    ['', '2'],
    ['1', ''],
    ['abc', '2'],
  ])(
    'rejects non-numeric ids metadataId=%j thumbId=%j with 400',
    async (metadataId, thumbId) => {
      const req = makeReq({ providerIndex: '0', metadataId, thumbId });
      const res = makeRes([provider]);
      await posterHandler(req, res);
      expect(res.statusCode).toBe(400);
      expect(res.send).toHaveBeenCalledWith('Invalid media id');
      expect(provider.getArtwork).not.toHaveBeenCalled();
    },
  );
});

describe('poster handler: upstream forward', () => {
  it('forwards content-type and content-length from upstream', async () => {
    const provider = makeProvider({
      getArtwork: vi.fn().mockResolvedValue([
        makeStream(Buffer.from('imgdata')),
        new Headers({
          'content-type': 'image/jpeg',
          'content-length': '7',
        }),
      ]),
    });
    const req = makeReq({ providerIndex: '0', metadataId: '12', thumbId: '34' });
    const res = makeRes([provider]);

    await posterHandler(req, res);
    // The pipe runs asynchronously after handler returns; wait a tick
    // for the stream to drain into res.write.
    await new Promise((r) => setImmediate(r));

    expect(provider.getArtwork).toHaveBeenCalledWith('12/34', expect.any(AbortSignal));
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-length']).toBe('7');
  });

  it('omits content-length when upstream did not provide one', async () => {
    const provider = makeProvider({
      getArtwork: vi.fn().mockResolvedValue([
        makeStream(Buffer.from('chunky')),
        new Headers({ 'content-type': 'image/png' }),
      ]),
    });
    const req = makeReq({ providerIndex: '0', metadataId: '5', thumbId: '6' });
    const res = makeRes([provider]);

    await posterHandler(req, res);
    await new Promise((r) => setImmediate(r));

    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBeUndefined();
  });

  it('returns 502 when provider.getArtwork rejects', async () => {
    const provider = makeProvider({
      getArtwork: vi.fn().mockRejectedValue(new Error('upstream timeout')),
    });
    const req = makeReq({ providerIndex: '0', metadataId: '1', thumbId: '2' });
    const res = makeRes([provider]);

    await posterHandler(req, res);

    expect(res.statusCode).toBe(502);
    expect(res.send).toHaveBeenCalledWith('Failed to fetch artwork');
  });

  it('does not write a status code if headers were already sent before rejection', async () => {
    // Simulates the path where headers got forwarded + the stream
    // started, then the stream threw downstream. headersSent is true so
    // the catch branch skips res.status(502).
    const provider = makeProvider({
      getArtwork: vi.fn().mockImplementation(async () => {
        throw new Error('post-headers boom');
      }),
    });
    const req = makeReq({ providerIndex: '0', metadataId: '1', thumbId: '2' });
    const res = makeRes([provider]);
    res.headersSent = true;

    await posterHandler(req, res);

    // Status was NOT overridden to 502 (the headersSent guard kicked in).
    expect(res.statusCode).toBe(200);
    expect(res.send).not.toHaveBeenCalled();
  });
});

describe('poster handler: abort + stream-error handling', () => {
  it('aborts the upstream fetch when the response closes', async () => {
    let capturedSignal: AbortSignal | undefined;
    const provider = makeProvider({
      getArtwork: vi.fn().mockImplementation(async (_key: string, signal: AbortSignal) => {
        capturedSignal = signal;
        return [makeStream(Buffer.from('x')), new Headers()];
      }),
    });
    const req = makeReq({ providerIndex: '0', metadataId: '1', thumbId: '2' });
    const res = makeRes([provider]);

    await posterHandler(req, res);
    expect(capturedSignal?.aborted).toBe(false);

    res.emit('close');
    expect(capturedSignal?.aborted).toBe(true);
  });
});
