// This test file intentionally contains `${...}` placeholder strings
// in its template fixtures -- the handler under test is exactly the
// thing that interpolates them. Suppressing the noTemplateCurlyInString
// rule file-wide rather than per-line keeps the fixtures readable.
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: template fixtures use literal ${...}.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

// readFile is mocked so we can supply our own template HTML without
// touching disk. The handler memoizes the result via util/memo;
// vi.resetModules in beforeEach is necessary so the memo cache
// re-initializes per test (each test can override the template body).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

const mockedGetConfig = vi.fn();
vi.mock('../../internal/app/reely/config/main', () => ({
  getConfig: mockedGetConfig,
}));

const mockedGetTranslations = vi.fn();
vi.mock('../../internal/app/reely/i18n', () => ({
  getTranslations: mockedGetTranslations,
}));

const mockedGetVersion = vi.fn();
vi.mock('../../internal/app/reely/version', () => ({
  getVersion: mockedGetVersion,
}));

import { readFile } from 'node:fs/promises';

const mockedReadFile = vi.mocked(readFile);

// ─── Stubs ──────────────────────────────────────────────────────────────

const makeReq = (headers: Record<string, string | string[] | undefined> = {}): Request =>
  ({ headers } as unknown as Request);

const makeRes = () => {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  const r = {
    statusCode: 200,
    setHeader: vi.fn((k: string, v: string) => { headers[k.toLowerCase()] = v; }),
    status: vi.fn(function (this: typeof r, code: number) {
      this.statusCode = code;
      return this;
    }),
    send: vi.fn(function (this: typeof r, payload: string) {
      body = payload;
      return this;
    }),
    headers,
    getBody: () => body,
  };
  return r as unknown as Response & typeof r;
};

const DEFAULT_TEMPLATE =
  '<html><head><title>reely ${version}</title></head>' +
  '<body><script>const root="${rootPath}";</script>${greeting}</body></html>';

// ─── Tests ──────────────────────────────────────────────────────────────

// resetModules between tests so `getTemplate`'s memo cache rebuilds
// against the per-test readFile mock value.
beforeEach(() => {
  vi.resetModules();
  mockedReadFile.mockResolvedValue(DEFAULT_TEMPLATE as never);
  mockedGetConfig.mockReturnValue({ rootPath: '' } as never);
  mockedGetTranslations.mockResolvedValue({ greeting: 'hello' });
  mockedGetVersion.mockResolvedValue('1.2.3');
});

describe('template handler: basic render', () => {
  it('substitutes ${version} from getVersion() and sends 200 + headers', async () => {
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/html');
    // The entry HTML must NOT be cached -- a deploy could otherwise
    // leave the browser pointing at non-existent old asset filenames
    // (template.ts comment, audit-history).
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.getBody()).toContain('reely 1.2.3');
  });

  it('substitutes ${rootPath} from config when no proxy header is set', async () => {
    mockedGetConfig.mockReturnValue({ rootPath: '/reely' } as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toContain('const root="/reely";');
  });

  it('substitutes translations into the template', async () => {
    mockedGetTranslations.mockResolvedValue({ greeting: 'salut' });
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toContain('salut');
  });
});

describe('template handler: HTML escaping (XSS defense)', () => {
  it('escapes &, <, >, ", \' in substituted values', async () => {
    mockedGetTranslations.mockResolvedValue({
      greeting: `<script>alert("xss & 'pwn'")</script>`,
    });
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    const body = res.getBody() ?? '';
    // Raw script tag must not appear; escaped form must.
    expect(body).not.toContain('<script>alert');
    expect(body).toContain('&lt;script&gt;alert(&quot;xss &amp; &#39;pwn&#39;&quot;)&lt;/script&gt;');
  });
});

describe('template handler: rootPath resolution', () => {
  it('reads x-forwarded-prefix header in preference to config', async () => {
    mockedGetConfig.mockReturnValue({ rootPath: '/from-config' } as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': '/from-proxy' }),
      res,
    );
    expect(res.getBody()).toContain('const root="/from-proxy";');
  });

  it('takes the first element when x-forwarded-prefix is an array', async () => {
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': ['/first', '/second'] }),
      res,
    );
    expect(res.getBody()).toContain('const root="/first";');
  });

  it('strips all whitespace from the prefix (not just edges)', async () => {
    // audit 9 #161: a proxy that forwards internal whitespace must not
    // poison the template -- silently drop the whitespace.
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': '  /re ely  ' }),
      res,
    );
    expect(res.getBody()).toContain('const root="/reely";');
  });

  it('strips a trailing slash from the prefix', async () => {
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(
      makeReq({ 'x-forwarded-prefix': '/reely/' }),
      res,
    );
    expect(res.getBody()).toContain('const root="/reely";');
  });

  // audit 12 #224: hostile header chars (.., <, >, etc) get HTML-escaped
  // at substitution but could land in href/src URL contexts where URL
  // parsers don't apply HTML escaping. Allowlist drops the value
  // entirely so the misconfiguration surfaces immediately.
  it.each([
    '/../system',     // .. path traversal -- caught by the explicit `..` check (added in this batch)
    '/foo/../bar',    // .. anywhere in the path, not just leading
    '/<script>',      // < / > rejected by the allowlist
    '/path?query',    // ? rejected by the allowlist
    '/path#fragment', // # rejected by the allowlist
    '/path&query=1',  // & rejected by the allowlist
  ])(
    'drops invalid prefix %j to empty string',
    async (badPrefix) => {
      const { handler } = await import('../../internal/app/reely/handlers/template');
      const res = makeRes();
      await handler(makeReq({ 'x-forwarded-prefix': badPrefix }), res);
      const body = res.getBody() ?? '';
      // After whitespace strip + trailing-slash strip + ..-check +
      // allowlist check, a failed gate drops the candidate to ''.
      expect(body).toContain('const root="";');
    },
  );

  it('strips internal whitespace BEFORE allowlist check, so /a b c becomes /abc (valid)', async () => {
    // Whitespace-rich paths are rescued by the audit-9 #161 strip, not
    // rejected outright. The resulting compact form passes the allowlist
    // when its remaining chars are valid.
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq({ 'x-forwarded-prefix': '/a b c' }), res);
    expect(res.getBody()).toContain('const root="/abc";');
  });

  it('falls back to empty string when neither header nor config is set', async () => {
    mockedGetConfig.mockReturnValue({} as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toContain('const root="";');
  });
});

describe('template handler: missing-key + dotted-path resolution', () => {
  it('substitutes a missing key as empty string (not "undefined")', async () => {
    mockedGetTranslations.mockResolvedValue({});
    mockedReadFile.mockResolvedValue('greeting=[${greeting}]' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toBe('greeting=[]');
  });

  it('walks dotted paths through nested translation objects', async () => {
    mockedGetTranslations.mockResolvedValue({
      user: { name: 'Alice' },
    });
    mockedReadFile.mockResolvedValue('hi ${user.name}' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toBe('hi Alice');
  });

  // audit 10 #168: the prior reduce form silently returned the parent
  // string when a later segment ran off the end (e.g. context {a: "x"}
  // and keyPath ['a','b'] returned "x"). Now: returns '' the moment any
  // intermediate node isn't an object.
  it('returns empty string when a dotted path runs into a non-object', async () => {
    mockedGetTranslations.mockResolvedValue({ a: 'x' });
    mockedReadFile.mockResolvedValue('val=[${a.b}]' as never);
    const { handler } = await import('../../internal/app/reely/handlers/template');
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.getBody()).toBe('val=[]');
  });
});
