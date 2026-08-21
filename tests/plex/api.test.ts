import { describe, it, expect, vi, afterEach } from 'vitest';

// The factory covers addRedaction, which PlexApi's constructor calls.
import { loggerMockFactory } from '../helpers';
vi.mock('../../internal/app/reely/logger', () => loggerMockFactory());

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
