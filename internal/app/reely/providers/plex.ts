import type {
  Filter,
  Filters,
  FilterValue,
  Library,
  Media,
} from '../../../../types/reely';
import { PlexApi } from '../../plex/api';
import type { ReelyProvider } from './types';
import type { FieldType } from '../../plex/types/library_items';
import { fanOutLibraries, filterToQueryString } from '../../plex/util';
import { logger } from '../logger';
import { cachePromise, memo1TTL } from '../util/memo';

export interface PlexProviderConfig {
  url: string;
  token: string;
  libraryTitleFilter?: string[];
}

export const filtersToPlexQueryString = (
  filters?: Filter[],
): URLSearchParams => {
  // Not a Record: repeated keys keep multi-value filters intact. Joining would
  // split a value containing ',' into N values Plex-side.
  const queryString = new URLSearchParams();

  if (filters) {
    for (const filter of filters) {
      // Synthetic reely-side filters: library in getMedia, rating as a
      // post-filter in getMediaCached. Neither reaches Plex.
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

// Stable cache key for a filter set. JSON.stringify, not a delimiter join, so a
// value containing `,` or `|` can't collide with a different set. Both levels
// are sorted so toggle order doesn't miss the cache.
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

  // TTL bounds staleness so a Plex-side rename or add shows up without a
  // restart; failure clears the slot so an outage recovers. Movies-only by
  // design, so the type filter runs at the cache boundary.
  const LIBRARIES_TTL_MS = 60 * 60 * 1000;
  const librariesCache = cachePromise<Library[]>(async () => {
    const plexLibraries = await api.getLibraries();
    const libraries = plexLibraries
      .filter((library) => library.type === 'movie')
      .map((library) => ({
        title: library.title,
        key: library.key,
        type: 'movie',
      }) satisfies Library);
    if (libraries.length === 0) {
      // A Plex still bringing its library database up after a host reboot
      // answers /library/sections 200 with nothing in it, and so does a
      // libraryTitleFilter that matches nothing. Resolving with [] would be a
      // success by cachePromise's definition and pin the empty answer for the
      // full hour, wedging every room create long after Plex recovered.
      throw new Error('Plex returned no movie libraries');
    }
    return libraries;
  }, LIBRARIES_TTL_MS);

  const getLibraries = (): Promise<Library[]> => librariesCache.get();

  // filterKey -> canonical per-library key -> every per-library key sharing
  // that title. Written by getFilterValues, read by getMediaCached, so picking
  // "Action" queries every library's local "Action" key instead of dropping the
  // non-canonical ones. Per provider instance; rewritten on each fetch.
  const valueExpansion = new Map<string, Map<string, string[]>>();

  // Widen each picked value to every per-library key for it. Unknown filter
  // keys and unknown values pass through unchanged: one untouched value beats
  // zero matches.
  const expandFilterValues = (filters?: Filter[]): Filter[] | undefined =>
    filters?.map((f) => {
      const lookup = valueExpansion.get(f.key);
      if (!lookup) return f;
      const expanded = f.value.flatMap((v) => lookup.get(v) ?? [v]);
      return { ...f, value: expanded };
    });

  // Synthetic keys are answered locally and never build an expansion.
  const SYNTHETIC_FILTER_KEYS = new Set(['library', 'rating']);

  const getFilterValues = async (key: string): Promise<FilterValue[]> => {
    // Served locally so the library selector doesn't hit Plex.
    if (key === 'library') {
      const libs = await getLibraries();
      return libs.map((lib) => ({ value: lib.key, title: lib.title }));
    }

    // Plex ratings are already 0-10; getMediaCached floors into these buckets.
    if (key === 'rating') {
      // Top bucket is "9.0-10": the post-filter clamps a perfect 10.0 here.
      return Array.from({ length: 10 }, (_, i) => ({
        value: String(i),
        title: i === 9 ? '9.0-10' : `${i}.0-${i}.9`,
      }));
    }

    const filterValues = await api.getFilterValues(key);

    if (filterValues.size) {
      // Multi-library servers return the same value ("Action") under a
      // different key per library. Collapse them by title, keeping the first
      // key as canonical for the UI to send back, and record the rest in
      // `valueExpansion` so getMediaCached can query all of them.
      const dedupByTitle = new Map<string, string>(); // title -> canonicalKey
      const expansionByCanonical = new Map<string, string[]>();

      for (const filterValue of filterValues.Directory) {
        const existingCanonical = dedupByTitle.get(filterValue.title);
        if (existingCanonical === undefined) {
          dedupByTitle.set(filterValue.title, filterValue.key);
          expansionByCanonical.set(filterValue.key, [filterValue.key]);
        } else {
          // biome-ignore lint/style/noNonNullAssertion: existingCanonical implies the entry exists.
          expansionByCanonical.get(existingCanonical)!.push(filterValue.key);
        }
      }

      if (filterValues.partial) {
        // A section that failed contributed no keys, so replacing outright
        // would drop that library's equivalents and silently shrink every
        // later filtered deck until some future fetch succeeds in full. Keep
        // what the last complete answer knew for canonicals this one missed.
        const previous = valueExpansion.get(key);
        if (previous) {
          for (const [canonical, keys] of previous) {
            const current = expansionByCanonical.get(canonical);
            if (!current) {
              expansionByCanonical.set(canonical, keys);
              continue;
            }
            for (const equivalent of keys) {
              if (!current.includes(equivalent)) current.push(equivalent);
            }
          }
        }
        logger.warn(
          `Filter values for "${key}" came back from only some library sections; the expansion may be incomplete`,
        );
      }

      // Overwrite so a Plex-side library add or remove eventually shows up.
      valueExpansion.set(key, expansionByCanonical);

      return [...dedupByTitle.entries()].map(([title, value]) => ({
        value,
        title,
      }));
    }

    return [];
  };

  // A restored room replays its persisted filters before anyone has opened the
  // filter panel, so on a fresh process `valueExpansion` is empty and a picked
  // key matches only the library it came from: the deck silently loses every
  // other library's titles. Resolve the expansion for the keys actually in play
  // first. Single-library servers have nothing to expand, and a failure here
  // just leaves the values unexpanded, which is what happened before.
  const warmValueExpansion = async (filters?: Filter[]): Promise<void> => {
    if (!filters?.length) return;
    const missing = [...new Set(filters.map((f) => f.key))].filter(
      (key) => !SYNTHETIC_FILTER_KEYS.has(key) && !valueExpansion.has(key),
    );
    if (missing.length === 0) return;
    if ((await getLibraries()).length < 2) return;
    await Promise.all(missing.map(async (key) => {
      try {
        await getFilterValues(key);
      } catch (err) {
        logger.warn(`Could not resolve filter values for "${key}": ${String(err)}`);
      }
    }));
  };

  // Plex's own filter vocabulary is static for the process lifetime, but the
  // synthetic `library` entry below is derived from the live library list, so
  // this carries the same TTL as librariesCache: add or remove a Plex library
  // and the Library selector appears or disappears without a restart. The TTL
  // also keeps a degraded snapshot (an outage during the first fetch) from
  // outliving the outage that produced it. One entry, keyed on a constant.
  const getFiltersCached = memo1TTL(async (_key: string): Promise<Filters> => {
    const meta = await api.getAllFilters();

    const filters = new Map<string, {
      title: string;
      key: string;
      type: string;
    }>();

    // Movies-only: skip Plex's show / artist / photo type buckets.
    for (const type of meta.Type) {
      if (type.type === 'movie' && type.Filter) {
        for (const filter of type.Filter) {
          if (!filters.has(filter.filter)) {
            // Plex may omit Field entirely; fall back to filter.filterType.
            const filterType = type.Field?.find((_) =>
              _.key === filter.filter
            )?.type ?? filter.filterType;
            // Type drives operator rendering, so an untyped filter can't render.
            // Drop it rather than ship undefined on the wire.
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

    // Only worth a selector when there is more than one library to pick from.
    const libs = await getLibraries();
    if (libs.length > 1) {
      filters.set('library', {
        title: 'Library',
        key: 'library',
        type: 'tag',
      });
    }

    // Synthetic: Plex's own rating buckets are coarse 5-star values, so reely
    // offers 10 1-unit buckets instead. Values come from getFilterValues and
    // are applied as a post-filter in getMediaCached, since Plex's filter API
    // can't express a multi-bucket OR.
    filters.set('rating', {
      title: 'Rating',
      key: 'rating',
      type: 'reelyBucket',
    });

    // Plex emits the date "is before" operator as '<<' with no trailing '=',
    // unlike every other operator. isValidFilter and filterToQueryString both
    // assume the terminated form, so a client echoing '<<' back fails
    // validation. Normalize here; Plex accepts `field<<=value` either way.
    const normalizeOperatorKey = (key: string): string =>
      key.endsWith('=') ? key : `${key}=`;
    const filterTypes = {
      ...Object.fromEntries(
        meta.FieldType.map((ft: FieldType) => [
          ft.type,
          ft.Operator.map((op) => ({ ...op, key: normalizeOperatorKey(op.key) })),
        ]),
      ),
      // Buckets are a categorical multi-select and the post-filter implements
      // only these two. Advertising more (>>=, <<=) would let the UI offer
      // comparisons that silently degrade to equality.
      reelyBucket: [
        { key: '=', title: 'is' },
        { key: '!=', title: 'is not' },
      ],
    } as Filters['filterTypes'];

    return {
      filters: [...filters.values()],
      filterTypes,
    };
  }, LIBRARIES_TTL_MS, 1);

  // Unshuffled lists cached per filter set; each room shuffles independently in
  // Room.fetchMedia after the hit. Caveat: a movie deleted in Plex inside the
  // window stays in the list, so its poster 404s until the entry expires.
  const getMediaCached = memo1TTL(
    async (_key: string, filters?: Filter[]): Promise<Media[]> => {
      // `filters` arrives already expanded, and _key is derived from that same
      // expanded set: a deck fetched before the per-library keys were known
      // must not be served to a caller that now knows them.
      const filterParams: URLSearchParams = filtersToPlexQueryString(filters);
      let filteredLibraries: Library[] = await getLibraries();

      const libraryFilter = filters?.find((f) => f.key === 'library');
      if (libraryFilter?.value?.length) {
        // Honour the operator the way the rating post-filter does: the field is
        // advertised as a tag, so the UI offers "is not", and inclusion-only
        // narrowing would turn an exclusion into exactly the selection the user
        // meant to remove.
        const exclude = libraryFilter.operator === '!=';
        filteredLibraries = filteredLibraries.filter((lib) =>
          libraryFilter.value.includes(lib.key) !== exclude
        );
      }

      const media: Media[] = [];

      // Parallel so one slow section doesn't block the rest, and tolerant so
      // one rejected section doesn't sink the whole media list.
      const fulfilled = await fanOutLibraries(
        filteredLibraries,
        'getMediaCached',
        (library) => api.getLibraryItems(library.key, { filters: filterParams }),
      );
      if (filteredLibraries.length > 0 && fulfilled.length === 0) {
        // Not the same thing as a filter set that matches nothing. Resolving
        // with [] here would cache the outage for the full TTL and tell the
        // user that their filters excluded everything, long after Plex is
        // healthy again. Throwing evicts the entry and surfaces the outage.
        throw new Error('Every library section failed when fetching media');
      }
      for (const libraryItems of fulfilled) {
        if (libraryItems.size) {
          for (const libraryItem of libraryItems.Metadata) {
            let posterUrl: string | undefined;
            if (libraryItem.thumb) {
              // Match by shape, not split('/') position: an extra prefix
              // segment or trailing /file/ would silently misalign indices.
              const m = libraryItem.thumb.match(
                /\/library\/metadata\/(\d+)\/thumb\/(\d+)/,
              );
              if (m) {
                const [, metadataId, thumbId] = m;
                posterUrl = `/api/poster/${id}/${metadataId}/${thumbId}`;
              }
            }
            media.push({
              // ratingKey, not guid: swipes and matches key on this, and guid
              // collides across libraries and changes on a metadata refresh.
              id: libraryItem.ratingKey,
              // Libraries are already filtered to movies.
              type: 'movie',
              title: libraryItem.title,
              description: libraryItem.summary,
              tagline: libraryItem.tagline,
              year: libraryItem.year,
              posterUrl,
              plexKey: libraryItem.key,
              genres: libraryItem.Genre?.map((_) => _.tag) ?? [],
              // Number(undefined) is NaN; ship undefined instead so consumers
              // don't have to guard NaN's accidental falsiness.
              duration: libraryItem.duration != null ? Number(libraryItem.duration) : undefined,
              rating: libraryItem.rating != null ? Number(libraryItem.rating) : undefined,
              contentRating: libraryItem.contentRating,
            });
          }
        }
      }

      // Plex can't express the synthetic buckets, so narrow here after the
      // Plex-side filters. '=' means in one of these buckets, '!=' means in
      // none; anything else a crafted client sends falls back to '='.
      // Unrated movies match neither, since surfacing them all on '!=' would
      // surprise more than help.
      const ratingFilter = filters?.find((f) => f.key === 'rating');
      if (ratingFilter && ratingFilter.value.length > 0) {
        const selectedBuckets = new Set(ratingFilter.value.map((v) => Number(v)));
        const exclude = ratingFilter.operator === '!=';
        return media.filter((m) => {
          if (m.rating == null) return false;
          // A rating of exactly 10.0 is attainable and floors to 10, which no
          // selectable bucket contains. Clamp into the top bucket, labeled
          // "9.0-10" to match.
          const bucket = Math.min(Math.floor(m.rating), 9);
          const inBucket = selectedBuckets.has(bucket);
          return exclude ? !inBucket : inBucket;
        });
      }

      return media;
    },
    5 * 60 * 1000,
    // Each entry is a whole-library Media[], the heaviest object in the
    // process, so this cache holds far fewer than the shared default.
    16,
  );

  return {
    type: 'plex',
    options: providerOptions,
    isAvailable: () => api.isAvailable(),
    // Plex is single-token: no per-user gating to apply. See
    // `ReelyProvider.isUserAuthorized`.
    isUserAuthorized: () => Promise.resolve(true),
    getName: () => api.getServerName(),
    getServerId: () => api.getServerId(),
    getLibraries,
    getFilters: () => getFiltersCached(''),
    getFilterValues,
    getArtwork: (
      key: string,
      signal?: AbortSignal,
    ): Promise<[ReadableStream<Uint8Array>, Headers]> =>
      api.getRawThumb(key, signal),
    getMedia: async ({ filters }) => {
      await warmValueExpansion(filters);
      const expanded = expandFilterValues(filters);
      return getMediaCached(normalizeFilters(expanded), expanded);
    },
  };
};
