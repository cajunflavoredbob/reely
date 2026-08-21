import { describe, expect, it } from 'vitest';
import { handler } from '../../internal/app/reely/handlers/serve_static';

// A thin express.static wrapper, so only its options are worth pinning. With
// index: true it would serve the raw index.html and the template handler's
// substitution would never run, leaving literal ${rootPath} in the browser.

describe('handler (serve_static)', () => {
  it('exports a callable Express middleware function', () => {
    expect(typeof handler).toBe('function');
    // express.static returns a 3-arg middleware.
    expect(handler.length).toBe(3);
  });

  // Falling through on "/" is what leaves index.html to the template handler.
  it('falls through to next() for "/" requests (index: false in effect)', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: partial stub; express.static reads only these.
    const req: any = {
      method: 'GET',
      url: '/',
      originalUrl: '/',
      path: '/',
      headers: {},
      query: {},
    };
    let nextCalled = false;
    // biome-ignore lint/suspicious/noExplicitAny: res stub for express middleware.
    const res: any = {
      headersSent: false,
      statusCode: 200,
      setHeader: () => {},
      getHeader: () => undefined,
      removeHeader: () => {},
      on: () => res,
      once: () => res,
      end: () => res,
    };
    await new Promise<void>((resolve) => {
      handler(req, res, () => {
        nextCalled = true;
        resolve();
      });
      // If next() never fires, fail the assertion rather than hang.
      setTimeout(resolve, 50);
    });
    expect(nextCalled).toBe(true);
  });
});

// Only Vite's content-hashed assets/ bundles get the year-long immutable
// Cache-Control. Long-caching the service worker would stall PWA updates for
// a year.
describe('setStaticHeaders', () => {
  const capture = () => {
    const headers: Record<string, string> = {};
    return {
      headers,
      res: { setHeader: (k: string, v: string) => { headers[k] = v; } },
    };
  };

  it('marks hashed assets/ files immutable for a year', async () => {
    const { setStaticHeaders } = await import(
      '../../internal/app/reely/handlers/serve_static'
    );
    const { sep } = await import('node:path');
    const { headers, res } = capture();
    setStaticHeaders(res, ['dist', 'web', 'assets', 'index-Ab12Cd34.js'].join(sep));
    expect(headers['Cache-Control']).toBe('public, max-age=31536000, immutable');
  });

  it('leaves non-asset files (service worker, manifest) on the default policy', async () => {
    const { setStaticHeaders } = await import(
      '../../internal/app/reely/handlers/serve_static'
    );
    const { sep } = await import('node:path');
    const { headers, res } = capture();
    setStaticHeaders(res, ['dist', 'web', 'sw.js'].join(sep));
    setStaticHeaders(res, ['dist', 'web', 'manifest.webmanifest'].join(sep));
    expect(headers['Cache-Control']).toBeUndefined();
  });
});
