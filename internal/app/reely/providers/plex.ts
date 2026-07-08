import type {
  Filter,
  Filters,
  Library,
  Media,
} from '../../../../types/reely';
import { PlexApi } from '../../plex/api';
import type { ReelyProvider } from './types';
import type { FieldType } from '../../plex/types/library_items';
import { fanOutLibraries, filterToQueryString } from '../../plex/util';
import { cachePromise, memo, memo1TTL } from '../util/memo';

export interface PlexProviderConfig {
  url: string;
  token: string;
  libraryTitleFilter?: string[];
}

// Audit 13 #317 verified clean: the audit claimed this was only used
// in this file, but `tests/plex/util.test.ts` imports it as part of
// the filterToQueryString -> filtersToPlexQueryString shape coverage.
// Keeping the export.
export const filtersToPlexQueryString = (
  filters?: Filter[],
): URLSearchParams => {
  // URLSearchParams (not a Record) so multi-value filters can use repeated
  // keys -- a value containing ',' would otherwise split into N values on
  // the Plex side when joined. filterToQueryString returns one tuple per
  // value; append() preserves repetition and URL-encodes each value.
  const queryString = new URLSearchParams();

  if (filters) {
    for (const filter of filters) {
      // 'library' + 'rating' are reely-side synthetic filters handled
      // separately (library in getMedia, rating as a post-filter in
      // getMediaCached -- audit 17 / 0.5.23); they never reach Plex's
      // query string.
      if (filter.key === 'library' || filter.key === 'rating') {
        continue;
      }

      for (const [key, value] of filterToQueryString(filter)) {
        queryString.append(key, value);
      }
    }
  }

  return queryString;
};

// Stable cache key for a filter set. JSON.stringify (not a delimiter join)
// so a filter value containing `,` or `|` can't collide with a different
// filter set that happens to produce the same joined string.
//
// Both the filters AND each filter's value array are sorted (audit 11 #185):
// two semantically-equivalent filter sets that differ only in checkbox-
// toggle order (`["Action","Drama"]` vs `["Drama","Action"]`) used to miss
// the 5-min cache.
const normalizeFilters = (filters?: Filter[]): string => {
  if (!filters?.length) return '';
  return JSON.stringify(
    [...filters]
      .map((f) => ({ ...f, value: [...f.value].sort() }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );
};

export const createProvider = (
  id: string,
  providerOptions: PlexProviderConfig,
): ReelyProvider => {
  const api = new PlexApi(
    providerOptions.url,
    providerOptions.token,
    providerOptions,
  );

  // Library list cache via the shared cachePromise helper (audit 12 #191
  // + #260). 1-hour TTL bounds staleness so a Plex-side rename / add /
  // remove eventually shows up without a restart; failures clear the
  // slot so a transient outage can recover. reely is movies-only by
  // design (0.4.1) so the type filter runs at the cache boundary --
  // "show" / "artist" / "photo" libraries are excluded here.
  const LIBRARIES_TTL_MS = 60 * 60 * 1000;
  const librariesCache = cachePromise<Library[]>(async () => {
    const plexLibraries = await api.getLibraries();
    return plexLibraries
      .filter((library) => library.type === 'movie')
      .map((library) => ({
        title: library.title,
        key: library.key,
        type: 'movie',
      }) satisfies Library);
  }, LIBRARIES_TTL_MS);

  const getLibraries = (): Promise<Library[]> => librariesCache.get();

  // Cross-library filter-value expansion (audit #299, 0.4.48). Keyed by
  // filter key (e.g. 'genre'), values map a canonical per-library key
  // (the first one encountered for a given title) to ALL per-library
  // keys that share that title. Populated by getFilterValues; consumed
  // by getMediaCached's filter pre-processing so a user picking
  // "Action" (one canonical key) sends a query that ORs across every
  // library's local "Action" key. Without this, the dedup-then-query
  // path silently dropped items from non-canonical libraries.
  //
  // Closure-scoped per provider instance. Overwrites on each
  // getFilterValues call so a Plex-side library add/remove eventually
  // shows up; staleness window matches the requestFilterValues cadence
  // (the UI re-fetches values on each FilterPanel open transition).
  const valueExpansion = new Map<string, Map<string, string[]>>();

  // Expand each Filter's value[] through valueExpansion so the Plex
  // query carries every per-library key for the canonical the user
  // picked. If no lookup exists for the filter key (the key was never
  // fetched, or it's a special key like 'library' that doesn't go
  // through the dedup path), pass the filter through unchanged. If a
  // value isn't in the lookup (stale lookup, or a value the dedup
  // didn't see), pass it through too -- one untouched value is better
  // than zero matches.
  const expandFilterValues = (filters?: Filter[]): Filter[] | undefined =>
    filters?.map((f) => {
      const lookup = valueExpansion.get(f.key);
      if (!lookup) return f;
      const expanded = f.value.flatMap((v) => lookup.get(v) ?? [v]);
      return { ...f, value: expanded };
    });

  // Filter metadata (genres, operators, field types) is static for the lifetime of the
  // server process -- cache the first successful response and reuse it.
  const getFiltersCached = memo(async (): Promise<Filters> => {
    const meta = await api.getAllFilters();

    const filters = new Map<string, {
      title: string;
      key: string;
      type: string;
    }>();

    // Only the "movie" type bucket contributes filters (movies-only since 0.4.1).
    // Plex's other types ("show", "artist", "photo") are skipped.
    for (const type of meta.Type) {
      if (type.type === 'movie' && type.Filter) {
        for (const filter of type.Filter) {
          if (!filters.has(filter.filter)) {
            // Optional-chaining on type.Field so a Plex type entry without
            // a Field array (rare, but the response shape allows it)
            // falls through to filter.filterType instead of throwing
            // through a non-null assertion (audit 9 #111).
            const filterType = type.Field?.find((_) =>
              _.key === filter.filter
            )?.type ?? filter.filterType;
            // Skip filters with no type rather than ship undefined on the
            // wire (audit 13 #297). The prior `type: filterType!` lied to
            // the type system when both type.Field?.find() and
            // filter.filterType returned undefined. A filter without a
            // type wouldn't render correctly in the UI anyway -- the type
            // drives operator-option rendering -- so dropping it silently
            // is the correct fail-soft behavior.
            if (!filterType) continue;
            filters.set(filter.filter, {
              title: filter.title,
              key: filter.filter,
              type: filterType,
            });
          }
        }
      }
    }

    // Expose a library selector when the server has more than one eligible library
    // so users can restrict a room to specific libraries at creation time.
    const libs = await getLibraries();
    if (libs.length > 1) {
      filters.set('library', {
        title: 'Library',
        key: 'library',
        type: 'tag',
      });
    }

    // Synthetic "rating" filter (audit 17 / 0.5.23). Plex's native
    // rating buckets via /library/sections/<key>/rating are coarse
    // 5-star (10, 8, 6, 4, 2, -1); reely synthesizes 10 1-unit buckets
    // (0.0-0.9 ... 9.0-9.9) for finer-grained selection. Filter values
    // are generated server-side in getFilterValues; selected buckets
    // are applied as a post-filter in getMediaCached after the Plex
    // fetch, because Plex's filter API doesn't accept reely's bucket
    // shape and a multi-bucket OR query isn't expressible in Plex's
    // URL params anyway.
    filters.set('rating', {
      title: 'Rating',
      key: 'rating',
      type: 'reelyBucket',
    });

    // Object.fromEntries instead of the canonical-anti-pattern
    // `reduce((acc, x) => ({ ...acc, [k]: v }), {})` (audit 14 #353).
    // The spread-in-reduce form is O(N^2): each iteration copies every
    // previously-accumulated key into a fresh object. Object.fromEntries
    // is O(N). meta.FieldType is small today (~6 entries), but the
    // anti-pattern shouldn't escape because the size CAN grow.
    // Plex emits the date "is before" operator as '<<' with NO trailing
    // '=' (pinned in plex/types/library_items.ts, audit 13 #300 / 14
    // #357) while every other operator is '='-terminated -- and both the
    // server's isValidFilter regex and filterToQueryString's
    // strip-the-trailing-'=' contract assume the terminated form, so a
    // client sending '<<' back verbatim failed validation. Normalize the
    // advertised vocabulary at this boundary ('<<' -> '<<=') so it
    // round-trips; the wire form Plex accepts is `field<<=value` either
    // way. (audit 16 #449)
    const normalizeOperatorKey = (key: string): string =>
      key.endsWith('=') ? key : `${key}=`;
    const filterTypes = {
      ...Object.fromEntries(
        meta.FieldType.map((ft: FieldType) => [
          ft.type,
          ft.Operator.map((op) => ({ ...op, key: normalizeOperatorKey(op.key) })),
        ]),
      ),
      // Operator vocabulary for the synthetic rating filter (audit 16
      // #426). The post-filter in getMediaCached implements only '=' and
      // '!='; under the previous `type: 'integer'` the UI offered Plex's
      // full integer operator set (>>=, <<=, ...) and every unimplemented
      // choice silently degraded to equality -- "rating is greater than 7"
      // returned only the 7.x bucket with no error. Buckets are
      // categorical multi-select, so equality semantics are the honest
      // vocabulary; restricting the advertised operators keeps the UI from
      // offering what the filter can't do.
      reelyBucket: [
        { key: '=', title: 'is' },
        { key: '!=', title: 'is not' },
      ],
    } as Filters['filterTypes'];

    return {
      filters: [...filters.values()],
      filterTypes,
    };
  });

  // Unshuffled media lists are cached per filter set for 5 minutes. Each room still
  // gets its own independent shuffle in Room.fetchMedia after the cache hit.
  //
  // Cache freshness caveat (audit 12 #234): a movie renamed / moved /
  // removed in Plex inside the 5-minute window stays in the cached list
  // until the entry expires. A swipe on a since-deleted media id still
  // succeeds against the cached metadata, but the poster proxy would
  // 404 (the upstream thumb is gone). Acceptable for the LAN use case;
  // shorter TTL or active invalidation can come later if it surfaces.
  const getMediaCached = memo1TTL(
    async (_key: string, filters?: Filter[]): Promise<Media[]> => {
      // Expand cross-library value equivalents (audit #299, 0.4.48):
      // a single canonical key the UI sent becomes the full set of
      // per-library keys with that title, so the Plex query OR-matches
      // each library's local key. See `valueExpansion` + `expandFilterValues`
      // above for the populate / consume mechanics. The cache key
      // (_key, derived from normalizeFilters before this call) uses
      // the ORIGINAL filters, so the cache hit/miss decision keys on
      // the user's pick, not the expanded form.
      const expanded = expandFilterValues(filters);
      const filterParams: URLSearchParams = filtersToPlexQueryString(expanded);
      let filteredLibraries: Library[] = await getLibraries();

      // Apply the library filter: restrict to user-selected libraries when specified.
      const libraryFilter = filters?.find((f) => f.key === 'library');
      if (libraryFilter?.value?.length) {
        filteredLibraries = filteredLibraries.filter((lib) =>
          libraryFilter.value.includes(lib.key)
        );
      }

      const media: Media[] = [];

      // Per-library fan-out via the shared helper (audit 13 #326). One
      // slow/unreachable section shouldn't make every other library wait
      // its turn; one rejected section shouldn't sink the whole media
      // list. Same parallel resilience as PlexApi.getAllFilters /
      // getFilterValues.
      const fulfilled = await fanOutLibraries(
        filteredLibraries,
        'getMediaCached',
        (library) => api.getLibraryItems(library.key, { filters: filterParams }),
      );
      for (const libraryItems of fulfilled) {
        if (libraryItems.size) {
          for (const libraryItem of libraryItems.Metadata) {
            let posterUrl: string | undefined;
            if (libraryItem.thumb) {
              // Plex returns thumb URLs in the form
              //   /library/metadata/<metadataId>/thumb/<thumbId>
              // Match the two ids by name so a future Plex format change
              // (extra prefix segment, trailing /file/, etc.) doesn't
              // silently misalign hard-coded positional indices the way
              // the prior split('/') + destructure would (audit 9 #112).
              const m = libraryItem.thumb.match(
                /\/library\/metadata\/(\d+)\/thumb\/(\d+)/,
              );
              if (m) {
                const [, metadataId, thumbId] = m;
                posterUrl = `/api/poster/${id}/${metadataId}/${thumbId}`;
              }
            }
            media.push({
              // ratingKey is Plex's stable per-server numeric identifier
              // (e.g. "12345"). guid is the metadata-agent identifier
              // (e.g. "plex://movie/5d776...") which can collide across
              // libraries and changes if Plex re-runs the agent match
              // (rare, but it happens on metadata refreshes). Swipes,
              // ratings, and match records all key on this value, so
              // ratingKey is the correct choice (audit 13 #279). Prior to
              // 0.4.19 this was libraryItem.guid; that had been silently
              // brittle since 0.1.x but no one hit the collision in
              // practice.
              id: libraryItem.ratingKey,
              // Locked to "movie" -- the provider already filters libraries
              // to the movie type, so Plex can only return movie items here.
              type: 'movie',
              title: libraryItem.title,
              description: libraryItem.summary,
              tagline: libraryItem.tagline,
              year: libraryItem.year,
              posterUrl,
              plexKey: libraryItem.key,
              genres: libraryItem.Genre?.map((_) => _.tag) ?? [],
              // Coerce only when present -- Number(undefined) is NaN, and
              // we'd rather ship `undefined` on the wire (matching Media's
              // optional types) than rely on UI consumers to .truthy-gate
              // around NaN's accidental falsiness.
              duration: libraryItem.duration != null ? Number(libraryItem.duration) : undefined,
              rating: libraryItem.rating != null ? Number(libraryItem.rating) : undefined,
              contentRating: libraryItem.contentRating,
            });
          }
        }
      }

      // Post-filter by rating buckets (audit 17 / 0.5.23). Plex doesn't
      // support reely's 10-bucket synthetic values, so we fetch with
      // all OTHER filters applied Plex-side then narrow the result
      // here. operator '=' means "in one of these buckets"; '!=' means
      // "in none of these buckets". The UI can only offer these two
      // (the reelyBucket filterType, audit 16 #426); anything else a
      // crafted client sends falls back to '='.
      // Unrated movies never match a rating filter -- they're excluded
      // from both '=' (no bucket to match) and '!=' (the contract is
      // "show movies whose rating is NOT in these buckets", and an
      // unrated movie's rating is in NO bucket, but surfacing every
      // unrated movie on '!=' would surprise the user more than it
      // would help).
      const ratingFilter = filters?.find((f) => f.key === 'rating');
      if (ratingFilter && ratingFilter.value.length > 0) {
        const selectedBuckets = new Set(ratingFilter.value.map((v) => Number(v)));
        const exclude = ratingFilter.operator === '!=';
        return media.filter((m) => {
          if (m.rating == null) return false;
          // Clamp to the top bucket (audit 16 #446): a rating of exactly
          // 10.0 is attainable (Plex critic ratings map 0-10; a 100% RT
          // score lands there) and floors to 10, which no selectable
          // bucket contains -- it was excluded from every '=' selection
          // and included by every '!='. The top bucket is labeled
          // "9.0–10" to match.
          const bucket = Math.min(Math.floor(m.rating), 9);
          const inBucket = selectedBuckets.has(bucket);
          return exclude ? !inBucket : inBucket;
        });
      }

      return media;
    },
    5 * 60 * 1000,
  );

  return {
    type: 'plex',
    options: providerOptions,
    isAvailable: () => api.isAvailable(),
    // Plex is single-token; no per-user gating to apply. See the
    // SCAFFOLDING comment on `ReelyProvider.isUserAuthorized` for the
    // Emby/Jellyfin rationale.
    isUserAuthorized: () => Promise.resolve(true),
    getName: () => api.getServerName(),
    getServerId: () => api.getServerId(),
    getLibraries,
    getFilters: getFiltersCached,
    getFilterValues: async (key: string) => {
      // Return the list of available libraries as filter values so the UI can
      // populate the library selector without hitting the Plex API.
      if (key === 'library') {
        const libs = await getLibraries();
        return libs.map((lib) => ({ value: lib.key, title: lib.title }));
      }

      // Rating buckets synthesized client-of-Plex (audit 17 / 0.5.23).
      // Per-movie rating from Plex is already on a 0-10 scale (e.g.
      // 3.7); the post-filter in getMediaCached uses Math.floor to
      // bucket. 10 buckets, each spanning 1.0 unit, matches the owner's
      // requested UX.
      if (key === 'rating') {
        // Top bucket is "9.0–10", not "9.0–9.9": the post-filter clamps a
        // perfect 10.0 into bucket 9 (audit 16 #446).
        return Array.from({ length: 10 }, (_, i) => ({
          value: String(i),
          title: i === 9 ? '9.0–10' : `${i}.0–${i}.9`,
        }));
      }

      const filterValues = await api.getFilterValues(key);

      if (filterValues.size) {
        // Dedupe by title: multi-library servers return the same value
        // (e.g. "PG-13", "Action") with different per-library keys. Keying
        // on title collapses visually-identical entries; we keep the first
        // key encountered (the "canonical" key) for the UI to send back at
        // apply time.
        //
        // 0.4.48 (audit #299): also build the expansion map
        // canonicalKey -> [all per-library keys with that title], stored
        // in `valueExpansion` (closure scope). When getMediaCached runs,
        // it expands each Filter.value entry through this map so the
        // Plex query carries `genre=15&genre=23` instead of just
        // `genre=15` -- which lets Family Movies's "Action" (key=23)
        // match alongside Movies's "Action" (key=15) on a fan-out.
        // Without the expansion, the pre-fix dedup-then-query path
        // silently dropped the other libraries' equivalent items.
        const dedupByTitle = new Map<string, string>(); // title -> canonicalKey
        const expansionByCanonical = new Map<string, string[]>();

        for (const filterValue of filterValues.Directory) {
          const existingCanonical = dedupByTitle.get(filterValue.title);
          if (existingCanonical === undefined) {
            dedupByTitle.set(filterValue.title, filterValue.key);
            expansionByCanonical.set(filterValue.key, [filterValue.key]);
          } else {
            // Append the per-library key to the canonical's expansion.
            // `!` is safe: existingCanonical was just set by a prior
            // iteration, so the expansion map has an entry for it.
            // biome-ignore lint/style/noNonNullAssertion: existingCanonical guarantees the entry exists (same-iteration invariant).
            expansionByCanonical.get(existingCanonical)!.push(filterValue.key);
          }
        }

        // Replace any prior expansion for this filter key. The lookup
        // overwrites on each call so a Plex-side library add/remove
        // eventually shows up; staleness window matches the
        // requestFilterValues cadence.
        valueExpansion.set(key, expansionByCanonical);

        return [...dedupByTitle.entries()].map(([title, value]) => ({
          value,
          title,
        }));
      }

      return [];
    },
    getArtwork: (
      key: string,
      signal?: AbortSignal,
    ): Promise<[ReadableStream<Uint8Array>, Headers]> =>
      api.getRawThumb(key, signal),
    getMedia: ({ filters }) => getMediaCached(normalizeFilters(filters), filters),
  };
};
