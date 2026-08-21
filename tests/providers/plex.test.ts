// biome-ignore-all lint/suspicious/noExplicitAny: setup shapes; the assertions are on the wire-level URLSearchParams.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each Plex library assigns its own key to the same filter title ("Action"
// is 15 in Movies and 23 in Family Movies). The UI gets one canonical key
// per title, and the provider remembers the per-library equivalents so
// getMedia queries all of them. Dedup without that expansion silently drops
// every item from the non-canonical libraries.
//
// PlexApi is mocked at the class boundary, so the assertions are on the
// URLSearchParams the provider hands to api.getLibraryItems.

// vi.hoisted so vi.mock's hoisted factory can read the class.
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
      // biome-ignore lint/correctness/noConstructorReturn: returns the shared mockApi so tests see calls made against `new PlexApi(...)`.
      return mockApi;
    }
  }
  return { mockApi, PlexApiMock };
});

vi.mock('../../internal/app/plex/api', () => ({ PlexApi: PlexApiMock }));

import { createProvider } from '../../internal/app/reely/providers/plex';

beforeEach(() => {
  for (const fn of Object.values(mockApi)) {
    if (typeof fn === 'object' && fn !== null && 'mockReset' in fn) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  // One library; multi-library tests override.
  mockApi.getLibraries.mockResolvedValue([
    { key: 'lib-1', title: 'Movies', type: 'movie' },
  ]);
  // Empty rather than undefined, so getMedia has something to iterate.
  mockApi.getLibraryItems.mockResolvedValue({ size: 0, Metadata: [] });
});

afterEach(() => {
  vi.useRealTimers();
});

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
        { title: 'Action', key: '23' }, // same title, different library
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

  // 'library' is the library selector, not a per-library value field, so it
  // returns the library list and builds no expansion.
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
    // The list comes from getLibraries directly.
    expect(mockApi.getFilterValues).not.toHaveBeenCalled();
  });
});

describe('Plex provider: cross-library expansion (audit #299)', () => {
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
    // Populates the lookup.
    await provider.getFilterValues('genre');
    // Filtering on Action's canonical key runs the expansion inside
    // getMediaCached.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['15'] }],
    });
    expect(mockApi.getLibraryItems).toHaveBeenCalled();
    const opts = mockApi.getLibraryItems.mock.calls[0]?.[1];
    const params = opts.filters as URLSearchParams;
    // Both keys, in their original order.
    expect(params.getAll('genre')).toEqual(['15', '23']);
  });

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
    // Action's expansion first, then Comedy's.
    expect(params.getAll('genre')).toEqual(['15', '23', '8', '19']);
  });

  // A missing lookup must not drop the filter.
  it('passes filter values through unchanged when no expansion lookup exists for the key', async () => {
    const provider = makeProvider();
    // No getFilterValues call, so no entry in valueExpansion.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['some-key'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.getAll('genre')).toEqual(['some-key']);
  });

  // A stale or unseen value still reaches Plex untouched, rather than none.
  it('passes individual values through when they are not in the lookup', async () => {
    mockApi.getFilterValues.mockResolvedValue({
      size: 1,
      Directory: [{ title: 'Action', key: '15' }],
    });
    const provider = makeProvider();
    await provider.getFilterValues('genre');
    // A value the lookup does not know.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['unknown-key'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.getAll('genre')).toEqual(['unknown-key']);
  });

  // One key per title, so the expansion is a no-op.
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
    // One library key for Action, so nothing is appended.
    expect(params.getAll('genre')).toEqual(['15']);
  });

  // Overwriting rather than merging is how a Plex-side library add or remove
  // reaches the expansion.
  it('re-fetching getFilterValues overwrites the prior expansion', async () => {
    // Two equivalents for Action.
    mockApi.getFilterValues.mockResolvedValueOnce({
      size: 2,
      Directory: [
        { title: 'Action', key: '15' },
        { title: 'Action', key: '23' },
      ],
    });
    const provider = makeProvider();
    await provider.getFilterValues('genre');
    // Family Movies removed, so one entry remains.
    mockApi.getFilterValues.mockResolvedValueOnce({
      size: 1,
      Directory: [{ title: 'Action', key: '15' }],
    });
    await provider.getFilterValues('genre');
    // The expansion now reflects the second fetch.
    await provider.getMedia({
      filters: [{ key: 'genre', operator: '=', value: ['15'] }],
    });
    const params = mockApi.getLibraryItems.mock.calls[0]?.[1].filters as URLSearchParams;
    expect(params.getAll('genre')).toEqual(['15']);
  });
});

// Rating is synthetic: buckets, post-filter semantics and a query-string
// skip, none of which any other test touches.
describe('Plex provider: synthetic rating filter', () => {
  // C is unrated: the field is omitted.
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
    expect(values[0]).toEqual({ value: '0', title: '0.0-0.9' });
    // The top bucket spans to 10: the post-filter clamps a perfect 10.0.
    expect(values[9]).toEqual({ value: '9', title: '9.0-10' });
    expect(mockApi.getFilterValues).not.toHaveBeenCalled();
  });

  it('a movie rated exactly 10.0 lands in the top bucket', async () => {
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
    expect(media.map((m) => m.id)).toEqual(['a']); // 3.7 falls in bucket 3
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
    // A is in bucket 3; C is unrated and never matches a rating filter.
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

  // Advertising Plex's full integer operator set made the UI offer operators
  // the post-filter does not implement, silently degrading them to equality.
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

// Plex advertises date "is before" as a bare '<<', which isValidFilter
// rejects when the client echoes it back, so getFilters normalizes advertised
// operator keys to the '='-terminated form.
describe('Plex provider: operator vocabulary normalization', () => {
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
