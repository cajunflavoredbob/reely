import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// The factory covers addRedaction, which PlexApi's constructor calls.
import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

import { logger } from '../../internal/app/reely/logger';
import { PlexApi } from '../../internal/app/plex/api';

// Routes by URL to a MediaContainer payload. Returning undefined yields a
// 404, so an unexpected request fails loudly instead of hanging the merge.
const stubFetch = (handler: (url: URL) => unknown) => {
  const mock = vi.fn(async (href: string) => {
    const url = new URL(href);
    const container = handler(url);
    if (container === undefined) {
      return { ok: false, status: 404, text: async (): Promise<string> => 'not found' };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ MediaContainer: container }),
      text: async (): Promise<string> => '',
    };
  });
  vi.stubGlobal('fetch', mock);
  return mock;
};

const SECTIONS = {
  Directory: [
    { key: '1', title: 'Movies', type: 'movie' },
    { key: '2', title: 'TV Shows', type: 'show' },
    { key: '3', title: 'Audiobooks', type: 'artist' },
    { key: '4', title: 'Anime 4K', type: 'movie' },
  ],
};

beforeEach(() => {
  vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// The key is interpolated into a Plex API URL path, so separators or `..`
// would redirect the token-bearing request. Rejected here regardless of any
// caller-side validation.
describe('PlexApi.getFilterValues key validation (#59)', () => {
  const api = new PlexApi('http://localhost:32400', 'test-token', {});

  it.each(['../system', 'genre/../..', 'a/b', 'has space', '.', ''])(
    'rejects the invalid filter key %j without making a request',
    async (key) => {
      await expect(api.getFilterValues(key)).rejects.toThrow(/invalid filter key/i);
    },
  );
});

// Same path-traversal exposure as getFilterValues.
describe('PlexApi.getLibraryItems key validation', () => {
  const api = new PlexApi('http://localhost:32400', 'test-token', {});

  it.each(['../system', '1/../..', 'a/b', 'has space', '.', ''])(
    'rejects the invalid library key %j without making a request',
    async (key) => {
      await expect(api.getLibraryItems(key)).rejects.toThrow(/invalid library key/i);
    },
  );
});

// Plex returns 200 with Directory omitted, not [], when a section has no
// values for a filter. Spreading it unguarded threw, and every filter
// rendered as a free-text input. The fan-out is movie libraries only.
describe('PlexApi.getFilterValues 0.5.23 regression', () => {
  const valuesPath = (lib: string) => `/library/sections/${lib}/genre`;

  it('fans out only to movie libraries', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) => {
      if (url.pathname === '/library/sections') return SECTIONS;
      if (url.pathname === valuesPath('1')) {
        return { size: 1, Directory: [{ key: '9', title: 'Action' }] };
      }
      if (url.pathname === valuesPath('4')) {
        return { size: 1, Directory: [{ key: '12', title: 'Anime' }] };
      }
      return undefined;
    });

    const merged = await api.getFilterValues('genre');

    expect(merged.Directory.map((d) => d.title).sort()).toEqual(['Action', 'Anime']);
    const requested = mock.mock.calls.map(([href]) => new URL(href as string).pathname);
    expect(requested).not.toContain(valuesPath('2')); // show library skipped
    expect(requested).not.toContain(valuesPath('3')); // artist library skipped
  });

  it('merges a movie library that omits Directory as empty instead of throwing', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) => {
      if (url.pathname === '/library/sections') return SECTIONS;
      if (url.pathname === valuesPath('1')) {
        return { size: 2, Directory: [{ key: '9', title: 'Action' }, { key: '10', title: 'Drama' }] };
      }
      // 200 OK with Directory omitted entirely: the production shape.
      if (url.pathname === valuesPath('4')) return { size: 0 };
      return undefined;
    });

    const merged = await api.getFilterValues('genre');

    expect(merged.Directory).toHaveLength(2);
    expect(merged.size).toBe(2);
  });

  it('merges when the FIRST fulfilled response omits Directory', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) => {
      if (url.pathname === '/library/sections') return SECTIONS;
      if (url.pathname === valuesPath('1')) return { size: 0 }; // seed response empty
      if (url.pathname === valuesPath('4')) {
        return { size: 1, Directory: [{ key: '12', title: 'Anime' }] };
      }
      return undefined;
    });

    const merged = await api.getFilterValues('genre');

    expect(merged.Directory.map((d) => d.title)).toEqual(['Anime']);
    expect(merged.size).toBe(1);
  });

  it('throws the designed error when no movie libraries exist', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) => {
      if (url.pathname === '/library/sections') {
        return { Directory: [{ key: '2', title: 'TV Shows', type: 'show' }] };
      }
      return undefined;
    });

    await expect(api.getFilterValues('genre')).rejects.toThrow(/no movie libraries/i);
  });
});

// getAllFilters consumes only the Meta block, so it asks for a zero-item
// container rather than downloading every movie, and skips non-movie
// sections. The fallback covers a PMS that withholds Meta at size zero.
describe('PlexApi.getAllFilters meta-only fan-out', () => {
  const META = {
    Type: [{ type: 'movie', Filter: [{ filter: 'genre', title: 'Genre', filterType: 'tag' }] }],
    FieldType: [{ type: 'tag', Operator: [{ key: '=', title: 'is' }] }],
  };

  it('requests zero-size containers and only movie sections', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) => {
      if (url.pathname === '/library/sections') return SECTIONS;
      if (url.pathname === '/library/sections/1/all' || url.pathname === '/library/sections/4/all') {
        return { size: 0, Meta: META };
      }
      return undefined;
    });

    const meta = await api.getAllFilters();

    expect(meta.FieldType).toHaveLength(1);
    expect(meta.Type.map((t) => t.type)).toEqual(['movie', 'movie']);
    const allCalls = mock.mock.calls.map(([href]) => new URL(href as string));
    const itemFetches = allCalls.filter((u) => u.pathname.endsWith('/all'));
    expect(itemFetches).toHaveLength(2);
    for (const u of itemFetches) {
      expect(u.searchParams.get('X-Plex-Container-Size')).toBe('0');
    }
    expect(allCalls.some((u) => u.pathname === '/library/sections/2/all')).toBe(false);
  });

  it('falls back to a full fetch when the zero-size container returns no Meta', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) => {
      if (url.pathname === '/library/sections') {
        return { Directory: [{ key: '1', title: 'Movies', type: 'movie' }] };
      }
      if (url.pathname === '/library/sections/1/all') {
        if (url.searchParams.get('X-Plex-Container-Size') === '0') return { size: 0 };
        return { size: 2, Meta: META };
      }
      return undefined;
    });

    const meta = await api.getAllFilters();

    expect(meta.FieldType).toHaveLength(1);
    expect(meta.Type.map((t) => t.type)).toEqual(['movie']);
    const itemFetches = mock.mock.calls
      .map(([href]) => new URL(href as string))
      .filter((u) => u.pathname === '/library/sections/1/all');
    expect(itemFetches).toHaveLength(2); // zero-size attempt + full fallback
    expect(itemFetches[1].searchParams.has('X-Plex-Container-Size')).toBe(false);
  });
});

// A `file:` or `gopher:` URL would pass as a Plex server and route every
// derived request to a local file or another protocol (SSRF).
describe('PlexApi constructor URL scheme allowlist', () => {
  it.each(['http://localhost:32400', 'https://plex.example.com'])(
    'accepts the http/https scheme %j',
    (url) => {
      expect(() => new PlexApi(url, 'test-token', {})).not.toThrow();
    },
  );

  it.each([
    'file:///etc/passwd',
    'gopher://example.com',
    'ftp://files.example.com',
    'data:text/html,<script>',
  ])(
    'rejects the non-http(s) scheme %j',
    (url) => {
      expect(() => new PlexApi(url, 'test-token', {})).toThrow(/Invalid Plex URL scheme/i);
    },
  );
});

// An unpaged fetch ships the whole library in one response, so getLibraryItems
// walks 1000 at a time. Every fixture elsewhere fits in one page, so the
// accumulation, the Container-Start advance and the short-page exit are only
// exercised here.
describe('PlexApi.getLibraryItems pagination', () => {
  const PAGE_SIZE = 1000;
  // One shared array: concat copies references, so a hundred pages stay cheap.
  const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
    ratingKey: String(i),
    title: `Movie ${i}`,
  }));

  it('walks to the next page and concatenates until a page comes back short', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) => {
      if (url.pathname !== '/library/sections/1/all') return undefined;
      const start = Number(url.searchParams.get('X-Plex-Container-Start'));
      if (start === 0) {
        return { size: PAGE_SIZE, Metadata: fullPage, Meta: { Type: [] } };
      }
      return {
        size: 2,
        Metadata: [
          { ratingKey: 'tail-1', title: 'Tail 1' },
          { ratingKey: 'tail-2', title: 'Tail 2' },
        ],
      };
    });

    const result = await api.getLibraryItems('1');

    expect(result.Metadata).toHaveLength(PAGE_SIZE + 2);
    // size is recomputed from the accumulated items, not taken from a page.
    expect(result.size).toBe(PAGE_SIZE + 2);
    // Page order is preserved across the boundary.
    expect(result.Metadata[0].ratingKey).toBe('0');
    expect(result.Metadata[PAGE_SIZE].ratingKey).toBe('tail-1');
    // Fields that only the first page carries survive the merge.
    expect(result.Meta).toEqual({ Type: [] });
    const params = mock.mock.calls.map(([href]) => new URL(href as string).searchParams);
    expect(params.map((p) => p.get('X-Plex-Container-Start'))).toEqual(['0', '1000']);
    expect(params.map((p) => p.get('X-Plex-Container-Size'))).toEqual(['1000', '1000']);
  });

  it('makes exactly one request when the first page is short', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) =>
      url.pathname === '/library/sections/1/all'
        ? { size: 1, Metadata: [{ ratingKey: 'only', title: 'Only' }] }
        : undefined
    );

    const result = await api.getLibraryItems('1');

    expect(result.Metadata).toHaveLength(1);
    expect(mock.mock.calls).toHaveLength(1);
  });

  it('carries the caller filters onto every page', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) => {
      if (url.pathname !== '/library/sections/1/all') return undefined;
      const start = Number(url.searchParams.get('X-Plex-Container-Start'));
      return start === 0
        ? { size: PAGE_SIZE, Metadata: fullPage }
        : { size: 0, Metadata: [] };
    });

    await api.getLibraryItems('1', { filters: new URLSearchParams([['genre', '15']]) });

    const genres = mock.mock.calls.map(([href]) =>
      new URL(href as string).searchParams.get('genre')
    );
    expect(genres).toEqual(['15', '15']);
  });

  // A server that honours Container-Size but ignores Container-Start answers
  // every request with page one, so the short-page exit never fires.
  it('stops at the page cap instead of looping forever', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubFetch((url) =>
      url.pathname === '/library/sections/1/all'
        ? { size: PAGE_SIZE, Metadata: fullPage }
        : undefined
    );

    const result = await api.getLibraryItems('1');

    expect(mock.mock.calls).toHaveLength(100);
    expect(result.Metadata).toHaveLength(100 * PAGE_SIZE);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('X-Plex-Container-Start'))).toBe(true);
  });
});

// GETs are idempotent, so a blip or a 5xx is retried once. The loop also has to
// report the right cause when the attempts fail differently.
describe('PlexApi.fetch retry loop', () => {
  // Each entry answers one attempt: an Error rejects, everything else is
  // returned as the Response.
  const stubAttempts = (attempts: unknown[]) => {
    const mock = vi.fn(async () => {
      const next = attempts.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  const ok = (container: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ MediaContainer: container }),
    text: async (): Promise<string> => '',
  });
  const status = (code: number, body: string) => ({
    ok: false,
    status: code,
    json: async () => ({}),
    text: async (): Promise<string> => body,
  });

  it('retries a 5xx and returns the next attempt', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubAttempts([status(503, 'starting up'), ok({ machineIdentifier: 'abc' })]);

    await expect(api.getCapabilities()).resolves.toEqual({ machineIdentifier: 'abc' });
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const mock = stubAttempts([status(401, 'unauthorized'), ok({})]);

    await expect(api.getCapabilities()).rejects.toThrow(/Plex API error 401/);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('reports the last attempt status when every attempt is a 5xx', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubAttempts([status(502, 'bad gateway'), status(503, 'starting up')]);

    await expect(api.getCapabilities()).rejects.toThrow(/Plex API error 503: starting up/);
  });

  it('throws with the network error as cause when every attempt throws', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const boom = new TypeError('fetch failed');
    stubAttempts([boom, boom]);

    await expect(api.getCapabilities()).rejects.toMatchObject({
      message: expect.stringContaining('Plex fetch failed after 2 attempts'),
      cause: boom,
    });
  });

  // The stale Response from the retried attempt must not be what gets reported:
  // the timeout or connection reset is what actually decided the outcome.
  it('reports the transport failure, not the retried 5xx, when the last attempt throws', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    const boom = new TypeError('fetch failed');
    stubAttempts([status(503, 'starting up'), boom]);

    await expect(api.getCapabilities()).rejects.toMatchObject({
      message: expect.stringContaining('Plex fetch failed after 2 attempts'),
      cause: boom,
    });
  });
});

// A 200 carrying something other than a MediaContainer (a proxy's own page, a
// Plex error envelope) would otherwise hand callers undefined typed as the
// container and surface as a TypeError far from here.
describe('PlexApi.fetch response envelope', () => {
  it.each([
    ['an object with no MediaContainer', {}],
    ['a JSON array', []],
    ['a JSON scalar', 'ok'],
  ])('rejects a 200 whose body is %s', async (_label, body) => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async (): Promise<string> => '',
    })));

    await expect(api.getCapabilities()).rejects.toThrow(/no MediaContainer/i);
  });

  it('still reports unparseable JSON as a parse failure', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); },
      text: async (): Promise<string> => '',
    })));

    await expect(api.getCapabilities()).rejects.toThrow(/Failed to parse Plex API response/);
  });
});

// Section keys are interpolated into token-bearing URL paths, and a misspelled
// title filter leaves reely with no libraries while the server reports healthy.
describe('PlexApi.fetchLibraries hygiene', () => {
  it('drops a section whose key would escape the URL path', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) =>
      url.pathname === '/library/sections'
        ? {
          Directory: [
            { key: '../../identity', title: 'Traversal', type: 'movie' },
            { key: '1', title: 'Movies', type: 'movie' },
          ],
        }
        : undefined
    );

    expect((await api.getLibraries()).map((lib) => lib.key)).toEqual(['1']);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
    expect(warned.some((w) => w.includes('unusable section key'))).toBe(true);
  });

  it('warns with both sides when libraryTitleFilter matches nothing', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {
      libraryTitleFilter: ['movies'], // lowercase: the match is case-sensitive
    });
    stubFetch((url) => (url.pathname === '/library/sections' ? SECTIONS : undefined));

    expect(await api.getLibraries()).toEqual([]);
    const warned = vi.mocked(logger.warn).mock.calls.map((c) => String(c[0]));
    const match = warned.find((w) => w.includes('libraryTitleFilter matched no Plex library'));
    expect(match).toBeDefined();
    expect(match).toContain('"movies"'); // what the operator configured
    expect(match).toContain('"Movies"'); // what Plex actually offers
  });

  it('stays quiet when the title filter matches', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {
      libraryTitleFilter: ['Movies'],
    });
    stubFetch((url) => (url.pathname === '/library/sections' ? SECTIONS : undefined));

    expect((await api.getLibraries()).map((lib) => lib.title)).toEqual(['Movies']);
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });
});

// An outage is not an empty filter vocabulary: resolving with an empty Meta
// would pin a filter panel holding nothing but the synthetic entries.
describe('PlexApi.getAllFilters total failure', () => {
  it('rejects when every movie section fails', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) => (url.pathname === '/library/sections' ? SECTIONS : undefined));

    await expect(api.getAllFilters()).rejects.toThrow(/every library section failed/i);
  });

  it('still resolves empty when there are no movie sections to ask', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) =>
      url.pathname === '/library/sections'
        ? { Directory: [{ key: '2', title: 'TV Shows', type: 'show' }] }
        : undefined
    );

    await expect(api.getAllFilters()).resolves.toEqual({ Type: [], FieldType: [] });
  });
});

// Assigning the pathname instead of concatenating dropped a PLEX_URL path
// prefix and 404'd every poster behind a path-routing proxy.
describe('PlexApi.getRawThumb', () => {
  const stubThumb = (response: unknown) => {
    const mock = vi.fn(async (_href: string) => response);
    vi.stubGlobal('fetch', mock);
    return mock;
  };

  it('keeps a path prefix on the configured Plex URL', async () => {
    const api = new PlexApi('http://localhost:32400/plex', 'test-token', {});
    const headers = new Headers({ 'content-type': 'image/jpeg' });
    const body = { stream: true };
    const mock = stubThumb({ ok: true, status: 200, body, headers });

    const [stream, returnedHeaders] = await api.getRawThumb('123/456');

    expect(stream).toBe(body);
    expect(returnedHeaders).toBe(headers);
    const url = new URL(mock.mock.calls[0][0]);
    expect(url.pathname).toBe('/plex/library/metadata/123/thumb/456');
    expect(url.search).toBe(''); // the token rides in a header, never the query
  });

  it('throws with the truncated upstream body when Plex refuses', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubThumb({
      ok: false,
      status: 404,
      body: null,
      headers: new Headers(),
      text: async (): Promise<string> => 'x'.repeat(500),
    });

    await expect(api.getRawThumb('123/456')).rejects.toThrow(/^404: x{200}$/);
  });
});

// The caller builds a per-library key expansion from this, so an incomplete
// answer has to be distinguishable from a complete one.
describe('PlexApi.getFilterValues partial fan-out', () => {
  const valuesPath = (lib: string) => `/library/sections/${lib}/genre`;

  it('flags the result partial when a movie section fails', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) => {
      if (url.pathname === '/library/sections') return SECTIONS;
      if (url.pathname === valuesPath('1')) {
        return { size: 1, Directory: [{ key: '9', title: 'Action' }] };
      }
      return undefined; // the Anime 4K section 404s
    });

    const merged = await api.getFilterValues('genre');

    expect(merged.partial).toBe(true);
    expect(merged.Directory).toHaveLength(1);
  });

  it('is not partial when every movie section answers', async () => {
    const api = new PlexApi('http://localhost:32400', 'test-token', {});
    stubFetch((url) => {
      if (url.pathname === '/library/sections') return SECTIONS;
      if (url.pathname === valuesPath('1') || url.pathname === valuesPath('4')) {
        return { size: 1, Directory: [{ key: '9', title: 'Action' }] };
      }
      return undefined;
    });

    expect((await api.getFilterValues('genre')).partial).toBe(false);
  });
});
