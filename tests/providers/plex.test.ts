// biome-ignore-all lint/suspicious/noExplicitAny: PlexProviderConfig + getLibraryItems opts shapes aren't the point in test setup; the test asserts against the wire-level URLSearchParams it receives.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Audit #299 cross-library filter-value expansion (landed 0.4.48).
// These tests cover the provider's getFilterValues + getMedia
// interaction: when a Plex server hosts multiple libraries that each
// assign their own per-library key for the same filter title (e.g.
// "Action" is key=15 in Movies and key=23 in Family Movies), the UI
// receives ONE canonical key per title (the existing dedup) AND the
// provider remembers all the per-library equivalents so getMedia
// fans out a query that matches every library's local key.
//
// Pre-#299, the dedup-then-query path silently dropped items from
// non-canonical libraries (the user-selected canonical key only
// matched one library's content).
//
// PlexApi is mocked at the class boundary so the tests assert
// against the URLSearchParams the provider hands to
// api.getLibraryItems -- the actual wire-format effect.

// vi.hoisted so vi.mock's hoisted factory can read the class. Same
// pattern as the WS-client / Zustand-store mock harnesses in earlier
// batches.
const { mockApi, PlexApiMock } = vi.hoisted(() => {
  const mockApi = {
    getServerName: vi.fn().mockResolvedValue('mock-plex'),
    getServerId: vi.fn().mockResolvedValue('SERVER1'),
    getLibraries: vi.fn(),
    getAllFilters: vi.fn(),
    getFilterValues: vi.fn(),
    getLibraryItems: vi.fn(),
    getRawThumb: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
  class PlexApiMock {
    constructor() {
      // biome-ignore lint/correctness/noConstructorReturn: deliberate test double -- returning the shared mockApi from the constructor lets the test inspect calls the SUT makes against `new PlexApi(...)`. Legitimate JS constructor pattern.
      return mockApi;
    }
  }
  return { mockApi, PlexApiMock };
});

vi.mock('../../internal/app/plex/api', () => ({ PlexApi: PlexApiMock }));

import { createProvider } from '../../internal/app/reely/providers/plex';

beforeEach(() => {
  // Reset all api mock call records + implementations. Reseed with the
  // baseline returns each test typically needs.
  for (const fn of Object.values(mockApi)) {
    if (typeof fn === 'object' && fn !== null && 'mockReset' in fn) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  // Library list -- one library by default; tests override for the
  // multi-library cases.
  mockApi.getLibraries.mockResolvedValue([
    { key: 'lib-1', title: 'Movies', type: 'movie' },
  ]);
  // Default getLibraryItems -> empty response so getMedia doesn't try to
  // iterate over undefined.
  mockApi.getLibraryItems.mockResolvedValue({ size: 0, Metadata: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

// Helper: build a provider instance with the default mock api.
const makeProvider = () =>
  createProvider('0', {
    url: 'http://plex.local:32400',
    token: 'tok',
  } as any);

describe('Plex provider: getFilterValues dedup (unchanged behavior, pre-#299)', () => {
  it('dedupes by title, keeping the first per-library key as the canonical', async () => {
    mockApi.getFilterValues.mockResolvedValue({
      size: 3,
      Directory: [
        { title: 'Action', key: '15' },
        { title: 'Action', key: '23' }, // duplicate title, different lib
        { title: 'Comedy', key: '8' },
      ],
    });
    const provider = makeProvider();
    const values = await provider.getFilterValues('genre');
    expect(values).toEqual([
      { title: 'Action', value: '15' },
      { title: 'Comedy', value: '8' },
    ]);
  });

  it('returns empty array when the api response has no entries', async () => {
    mockApi.getFilterValues.mockResolvedValue({ size: 0, Directory: [] });
    const provider = makeProvider();
    expect(await provider.getFilterValues('genre')).toEqual([]);
  });

  // The 'library' key has its own special path -- it's the library
  // selector itself, not a per-library value field. It returns the
  // available libraries directly and doesn't populate the cross-library
  // expansion (libraries don't have multi-library aliases).
  it('handles the "library" filter key by returning the library list', async () => {
    mockApi.getLibraries.mockResolvedValue([
      { key: 'lib-1', title: 'Movies', type: 'movie' },
      { key: 'lib-2', title: 'Family Movies', type: 'movie' },
    ]);
    const provider = makeProvider();
    const values = await provider.getFilterValues('library');
    expect(values).toEqual([
      { value: 'lib-1', title: 'Movies' },
      { value: 'lib-2', title: 'Family Movies' },
    ]);
    // api.getFilterValues isn't called for the 'library' key -- the
    // library list comes from getLibraries directly.
    expect(mockApi.getFilterValues).not.toHaveBeenCalled();
  });
});

describe('Plex provider: cross-library expansion (audit #299)', () => {
  // The whole point of #299: a user picks "Action" (canonical key=15
  // from Movies); the provider remembers Family Movies also has an
  // "Action" at key=23; getMedia's query carries BOTH keys so each
  // library's local key matches its own content.

  it('builds the expansion lookup during getFilterValues', async () => {
    mockApi.getFilterValues.mockResolvedValue({
      size: 3,
      Directory: [
        { title: 'Action', key: '15' },
        { title: 'Action', key: '23' },
        { title: 'Comedy', key: '8' },
      ],
    });
    const provider = makeProvider();
    // Fetch values to populate the lookup.
    await provider.getFilterValues('genre');
    // Now apply a filter with the canonical key for "Action". The
    // expansion runs inside getMediaCached; we inspect the
    // URLSearchParams the provider passes to api.getLibraryItems.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['15'] }],
    });
    expect(mockApi.getLibraryItems).toHaveBeenCalled();
    const opts = mockApi.getLibraryItems.mock.calls[0]?.[1];
    const params = opts.filters as URLSearchParams;
    // Both keys must appear on the query, in their original order.
    // URLSearchParams.getAll preserves order and supports repeats.
    expect(params.getAll('genre')).toEqual(['15', '23']);
  });

  // Multiple selected values (e.g. user picks both "Action" and "Comedy")
  // each get expanded independently. With Action=[15,23] and Comedy=[8,19]
  // selected, the final query carries genre=15&genre=23&genre=8&genre=19.
  it('expands every selected canonical key independently', async () => {
    mockApi.getFilterValues.mockResolvedValue({
      size: 4,
      Directory: [
        { title: 'Action', key: '15' },
        { title: 'Action', key: '23' },
        { title: 'Comedy', key: '8' },
        { title: 'Comedy', key: '19' },
      ],
    });
    const provider = makeProvider();
    await provider.getFilterValues('genre');
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['15', '8'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    // Order: Action's expansion first (15, 23), then Comedy's (8, 19).
    expect(params.getAll('genre')).toEqual(['15', '23', '8', '19']);
  });

  // Filters with a key that was never looked up (e.g. getMedia called
  // before getFilterValues) pass through unchanged. This is the
  // pass-through path that prevents a missing lookup from dropping
  // the filter silently.
  it('passes filter values through unchanged when no expansion lookup exists for the key', async () => {
    const provider = makeProvider();
    // No prior getFilterValues call -> no entry in valueExpansion.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['some-key'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.getAll('genre')).toEqual(['some-key']);
  });

  // A value that ISN'T in the lookup (stale lookup, or a value the
  // dedup didn't see) also passes through unchanged. One untouched
  // value reaches Plex (and may match nothing) rather than zero.
  it('passes individual values through when they are not in the lookup', async () => {
    mockApi.getFilterValues.mockResolvedValue({
      size: 1,
      Directory: [{ title: 'Action', key: '15' }],
    });
    const provider = makeProvider();
    await provider.getFilterValues('genre');
    // Apply a value that the lookup doesn't know about.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['unknown-key'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.getAll('genre')).toEqual(['unknown-key']);
  });

  // Single-library deploys (the owner's case): each title has exactly ONE
  // per-library key, so expansion is a no-op (canonical key expands to
  // itself). This is the path that's always been correct; verify it
  // stays correct under the refactor.
  it('single-library deploys: canonical key expands to itself (no behavior change)', async () => {
    mockApi.getFilterValues.mockResolvedValue({
      size: 2,
      Directory: [
        { title: 'Action', key: '15' },
        { title: 'Comedy', key: '8' },
      ],
    });
    const provider = makeProvider();
    await provider.getFilterValues('genre');
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['15'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    // Action only had one library key, so the expansion is [15] -- no
    // additional keys appended.
    expect(params.getAll('genre')).toEqual(['15']);
  });

  // Re-calling getFilterValues OVERWRITES the prior expansion for that
  // key (Plex-side library add/remove eventually shows up). Verifies
  // the staleness-window invariant documented at the valueExpansion
  // closure scope.
  it('re-fetching getFilterValues overwrites the prior expansion', async () => {
    // First fetch: Action has two equivalents (15, 23).
    mockApi.getFilterValues.mockResolvedValueOnce({
      size: 2,
      Directory: [
        { title: 'Action', key: '15' },
        { title: 'Action', key: '23' },
      ],
    });
    const provider = makeProvider();
    await provider.getFilterValues('genre');
    // Second fetch: only one Action entry (Family Movies removed).
    mockApi.getFilterValues.mockResolvedValueOnce({
      size: 1,
      Directory: [{ title: 'Action', key: '15' }],
    });
    await provider.getFilterValues('genre');
    // Apply: expansion should now reflect the SECOND fetch.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['15'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.getAll('genre')).toEqual(['15']);
  });
});

// Audit 16 #437: the 0.5.23 synthetic rating feature (bucket values,
// post-filter semantics, query-string skip) shipped with zero coverage --
// an off-by-one in bucketing or a broken '!=' branch passed all 723 tests.
describe('Plex provider: synthetic rating filter (audit 16 #437 / 0.5.23)', () => {
  // Seed a media response with known ratings. C is unrated (field omitted).
  const seedLibraryItems = () => {
    mockApi.getLibraryItems.mockResolvedValue({
      size: 4,
      Metadata: [
        { ratingKey: 'a', title: 'A', key: '/library/metadata/1', rating: 3.7 },
        { ratingKey: 'b', title: 'B', key: '/library/metadata/2', rating: 9.0 },
        { ratingKey: 'c', title: 'C', key: '/library/metadata/3' },
        { ratingKey: 'd', title: 'D', key: '/library/metadata/4', rating: 4.2 },
      ],
    });
  };

  it('getFilterValues("rating") returns 10 synthetic buckets without calling the api', async () => {
    const provider = makeProvider();
    const values = await provider.getFilterValues('rating');
    expect(values).toHaveLength(10);
    expect(values[0]).toEqual({ value: '0', title: '0.0–0.9' });
    // Top bucket spans to 10 -- the post-filter clamps a perfect 10.0
    // into bucket 9 (audit 16 #446).
    expect(values[9]).toEqual({ value: '9', title: '9.0–10' });
    expect(mockApi.getFilterValues).not.toHaveBeenCalled();
  });

  it('a movie rated exactly 10.0 lands in the top bucket (audit 16 #446)', async () => {
    mockApi.getLibraryItems.mockResolvedValue({
      size: 2,
      Metadata: [
        { ratingKey: 'perfect', title: 'P', key: '/library/metadata/9', rating: 10.0 },
        { ratingKey: 'low', title: 'L', key: '/library/metadata/10', rating: 1.2 },
      ],
    });
    const provider = makeProvider();
    const media = await provider.getMedia({
      filters: [{ key: 'rating', operator: '=', value: ['9'] }],
    });
    expect(media.map((m) => m.id)).toEqual(['perfect']);
  });

  it("'=' keeps only movies whose floored rating is in a selected bucket, dropping unrated", async () => {
    seedLibraryItems();
    const provider = makeProvider();
    const media = await provider.getMedia({
      filters: [{ key: 'rating', operator: '=', value: ['3'] }],
    });
    expect(media.map((m) => m.id)).toEqual(['a']); // 3.7 -> bucket 3
  });

  it("'=' with multiple buckets keeps every match", async () => {
    seedLibraryItems();
    const provider = makeProvider();
    const media = await provider.getMedia({
      filters: [{ key: 'rating', operator: '=', value: ['3', '9'] }],
    });
    expect(media.map((m) => m.id)).toEqual(['a', 'b']);
  });

  it("'!=' excludes the selected buckets and still drops unrated movies", async () => {
    seedLibraryItems();
    const provider = makeProvider();
    const media = await provider.getMedia({
      filters: [{ key: 'rating', operator: '!=', value: ['3'] }],
    });
    // A (bucket 3) excluded; C unrated never matches a rating filter.
    expect(media.map((m) => m.id)).toEqual(['b', 'd']);
  });

  it('the synthetic rating key never reaches the Plex query string', async () => {
    seedLibraryItems();
    const provider = makeProvider();
    await provider.getMedia({
      filters: [
        { key: 'rating', operator: '=', value: ['3'] },
        { key: 'genre', operator: '=', value: ['15'] },
      ],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.has('rating')).toBe(false);
    expect(params.getAll('genre')).toEqual(['15']); // other filters unaffected
  });

  // Audit 16 #426: the rating filter must advertise ONLY the operators the
  // post-filter implements. Under the previous type: 'integer' the UI
  // offered Plex's full integer set and silently degraded everything but
  // '!=' to equality.
  it('getFilters advertises rating under the reelyBucket type with only = and !=', async () => {
    mockApi.getAllFilters.mockResolvedValue({
      Type: [{
        type: 'movie',
        Filter: [{ filter: 'genre', title: 'Genre', filterType: 'tag' }],
        Field: [{ key: 'genre', type: 'tag' }],
      }],
      FieldType: [
        { type: 'tag', Operator: [{ key: '=', title: 'is' }, { key: '!=', title: 'is not' }] },
        { type: 'integer', Operator: [{ key: '=', title: 'is' }, { key: '>>=', title: 'is greater than' }] },
      ],
    });
    const provider = makeProvider();
    const filters = await provider.getFilters();
    const rating = filters.filters.find((f) => f.key === 'rating');
    expect(rating?.type).toBe('reelyBucket');
    expect(filters.filterTypes.reelyBucket).toEqual([
      { key: '=', title: 'is' },
      { key: '!=', title: 'is not' },
    ]);
  });
});

// Audit 16 #449: Plex advertises the date "is before" operator as a bare
// '<<' (no trailing '='), which the server's own isValidFilter rejects if
// echoed back. The provider normalizes advertised operator keys to the
// '='-terminated form at the getFilters boundary.
describe('Plex provider: operator vocabulary normalization (audit 16 #449)', () => {
  it("normalizes a bare '<<' operator to '<<=' in filterTypes", async () => {
    mockApi.getAllFilters.mockResolvedValue({
      Type: [{ type: 'movie', Filter: [], Field: [] }],
      FieldType: [
        {
          type: 'date',
          Operator: [
            { key: '>>=', title: 'is after' },
            { key: '<<', title: 'is before' },
          ],
        },
      ],
    });
    const provider = makeProvider();
    const filters = await provider.getFilters();
    expect(filters.filterTypes.date).toEqual([
      { key: '>>=', title: 'is after' },
      { key: '<<=', title: 'is before' },
    ]);
  });
});
