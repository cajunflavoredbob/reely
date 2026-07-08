import { describe, expect, it } from 'vitest';
import { handler } from '../../internal/app/reely/handlers/serve_static';

// Smoke tests for the serve_static handler. The handler is a thin
// wrapper around `express.static(join(cwd, 'dist', 'web'), { index: false })`,
// so what's worth pinning is:
//   - The export exists and is a callable (express middleware function).
//   - `index: false` is set: the SPA shell (index.html) MUST be served
//     by the template handler (which injects rootPath / version / lang
//     at request time), not by express.static. If express.static
//     defaulted to index: true here, it'd serve the raw index.html and
//     the template-substitution would never run -- the browser would
//     see literal `${rootPath}` placeholders.
//
// The actual file-serving behavior is express.static itself (well
// covered upstream); we don't re-test that.
//
// (Audit 13 #338 originally classified this as "deliberately deferred
// -- trivial wrapper". Minimal smoke coverage added 0.4.50 as part of
// the 0.5.0 close-out.)

describe('handler (serve_static)', () => {
  it('exports a callable Express middleware function', () => {
    expect(typeof handler).toBe('function');
    // express.static returns a 3-arg middleware (req, res, next).
    expect(handler.length).toBe(3);
  });

  // `index: false` means the request for "/" (or any directory) does
  // NOT auto-serve index.html. Verified by calling the middleware with
  // a "/" request and observing it falls through to next() rather than
  // sending a response. This is the invariant that lets the template
  // handler own index.html serving.
  it('falls through to next() for "/" requests (index: false in effect)', async () => {
    // Minimal Express-shaped req/res/next that the express.static
    // internals will accept.
    // biome-ignore lint/suspicious/noExplicitAny: stub shapes for express middleware -- full Request/Response/NextFunction surface not the point.
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
      // Express middleware can be sync or async; either way, calling
      // next() resolves this promise. If express.static decided to send
      // index.html (index: true), it'd never call next.
      handler(req, res, () => {
        nextCalled = true;
        resolve();
      });
      // Defensive timeout via microtask -- if next() never fires within
      // a tick, we still want to resolve and let the assertion fail
      // loudly instead of hanging the test.
      setTimeout(resolve, 50);
    });
    expect(nextCalled).toBe(true);
  });
});

// Audit 16 #458: Vite's content-hashed bundles under assets/ are served
// with a one-year immutable Cache-Control; everything else (sw.js,
// manifest, icons) keeps the default max-age=0 revalidation -- long-caching
// the service worker would stall PWA updates for a year.
describe('setStaticHeaders (audit 16 #458)', () => {
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
