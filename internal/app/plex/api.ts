import { createHash } from 'node:crypto';
import { addRedaction, logger } from '../reely/logger';
import { cachePromise } from '../reely/util/memo';
import { getVersion } from '../reely/version';
import type { FilterValue, FilterValues } from './types/library_filter_values';
import type { Capabilities } from './types/capabilities';
type PlexMediaContainer<T> = { MediaContainer: T };
import type { Libraries, PlexLibrary } from './types/libraries_list';
import type { LibraryItems, Meta } from './types/library_items';
import { fanOutLibraries } from './util';

// No `language` field: locale is per-connection but PlexApi is shared, and Plex
// serves metadata in the metadata agent's language regardless of
// Accept-Language. UI strings are translated locally by i18n.
export interface PlexApiOptions {
  libraryTitleFilter?: string[];
}

// A hung Plex would otherwise leave fetch() pending forever, stalling callers
// and poisoning the cached promises. Long enough for a large LAN library scan.
const PLEX_FETCH_TIMEOUT_MS = 30_000;

// GETs are idempotent, so retrying a blip or 5xx is safe. Two attempts keeps a
// real outage from stalling the caller. 4xx is never retried.
const PLEX_RETRY_ATTEMPTS = 2;
const PLEX_RETRY_BACKOFF_MS = 300;

const isRetryableStatus = (status: number): boolean => status >= 500 && status < 600;

// `new URL` otherwise accepts any scheme, so `file:///etc/passwd` would be a
// valid "Plex server" and requests would read local files. Defense-in-depth:
// the env loader also requires a scheme.
const ALLOWED_PLEX_SCHEMES = new Set(['http:', 'https:']);

export class PlexApi {
  plexUrl: URL;
  options: PlexApiOptions;
  private plexToken: string;
  // X-Plex-Client-Identifier: sha256(plexUrl)[:32]. Derived, not persisted, so
  // the id is stable per Plex server with no state to store.
  private clientIdentifier: string;
  // Stable for the process lifetime. Caching the promise makes concurrent
  // first-callers share one fetch; failure clears the slot so an outage recovers.
  private capabilitiesCache = cachePromise<Capabilities>(() => this.fetch<Capabilities>('/'));
  // Piped through capabilitiesCache: / and /identity both return
  // machineIdentifier, so /identity would be a wasted round-trip.
  private serverIdCache = cachePromise<string>(
    () => this.getCapabilities().then((c) => c.machineIdentifier),
  );
  // getFilterValues and getAllFilters call getLibraries per invocation, and the
  // provider's librariesCache sits above this layer, so without a cache here
  // every uncached filter key costs a GET /library/sections.
  private sectionsCache = cachePromise<PlexLibrary[]>(
    () => this.fetchLibraries(),
    60_000,
  );

  constructor(plexUrl: string, plexToken: string, options: PlexApiOptions) {
    const parsed = new URL(plexUrl);
    if (!ALLOWED_PLEX_SCHEMES.has(parsed.protocol)) {
      throw new Error(
        `Invalid Plex URL scheme "${parsed.protocol}". Only http: and https: are allowed.`,
      );
    }
    this.plexUrl = parsed;
    this.plexToken = plexToken;
    this.options = options;
    this.clientIdentifier = createHash('sha256').update(plexUrl).digest('hex').slice(0, 32);
    // Defense-in-depth: loadConfig registers these, but a caller constructing
    // PlexApi directly would log them unredacted. addRedaction is idempotent.
    addRedaction(plexUrl);
    addRedaction(plexToken);
  }

  // Token goes in a header, never the query string: the query form leaks it
  // into log lines and Plex-echoed error bodies. Client-Identifier / Product /
  // Version identify reely so Plex doesn't treat it as an anonymous client.
  private async buildPlexHeaders(): Promise<Record<string, string>> {
    return {
      'X-Plex-Token': this.plexToken,
      'X-Plex-Client-Identifier': this.clientIdentifier,
      'X-Plex-Product': 'reely',
      'X-Plex-Version': await getVersion(),
    };
  }

  private async fetch<T>(
    key: string,
    { searchParams }: {
      // Not a Record: repeated keys carry multi-value filters
      // (genre=Action&genre=Drama).
      searchParams?: URLSearchParams;
    } = {},
  ): Promise<T> {
    const url = new URL(this.plexUrl.href);
    url.pathname = (url.pathname + key).replace(/\/+/g, '/');

    if (searchParams) {
      for (const [k, value] of searchParams) {
        url.searchParams.append(k, value);
      }
    }

    // Path only: href would echo every filter value into the log.
    logger.debug(`Plex fetch: ${url.pathname}`);

    // Built once, reused per attempt.
    const headers = {
      accept: 'application/json',
      ...(await this.buildPlexHeaders()),
    };
    let req: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < PLEX_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 300ms, 600ms, ...
        await new Promise((r) => setTimeout(r, PLEX_RETRY_BACKOFF_MS * 2 ** (attempt - 1)));
        logger.debug(`Plex fetch retry ${attempt}: ${url.pathname}`);
      }
      try {
        req = await fetch(url.href, {
          headers,
          signal: AbortSignal.timeout(PLEX_FETCH_TIMEOUT_MS),
        });
        // 4xx is a real error (or our bug): don't retry.
        if (req.ok || !isRetryableStatus(req.status)) break;
        lastError = new Error(`Plex API ${req.status} (retryable)`);
      } catch (err) {
        lastError = err;
      }
    }
    if (!req) {
      // Every attempt threw at the network layer: no Response to inspect.
      throw new Error(
        `Plex fetch failed after ${PLEX_RETRY_ATTEMPTS} attempts`,
        { cause: lastError },
      );
    }

    if (!req.ok) {
      // Plex errors can be multi-KB HTML pages; don't let one hijack a log line.
      const body = (await req.text()).slice(0, 200);
      throw new Error(`Plex API error ${req.status}: ${body}`);
    }

    try {
      const data: PlexMediaContainer<T> = await req.json();
      return data.MediaContainer;
    } catch (err) {
      // `cause` keeps the underlying JSON error visible, not just the wrapper.
      throw new Error('Failed to parse Plex API response', { cause: err });
    }
  }

  async isAvailable(): Promise<boolean> {
    // Not .size: legitimately 0 on a server with no libraries.
    // machineIdentifier is on every Plex response root.
    return typeof (await this.getCapabilities()).machineIdentifier === 'string';
  }

  getCapabilities(): Promise<Capabilities> {
    return this.capabilitiesCache.get();
  }

  async getServerName(): Promise<string> {
    return (await this.getCapabilities()).friendlyName;
  }

  getServerId(): Promise<string> {
    return this.serverIdCache.get();
  }

  getLibraries(): Promise<PlexLibrary[]> {
    return this.sectionsCache.get();
  }

  private async fetchLibraries(): Promise<PlexLibrary[]> {
    const sections = await this.fetch<Libraries>('/library/sections');
    // Plex omits Directory entirely on a zero-section server.
    const dirs = sections.Directory ?? [];
    if (dirs.length === 0) {
      return [];
    }

    let filteredLibraries = dirs;

    if (this.options.libraryTitleFilter?.length) {
      filteredLibraries = filteredLibraries.filter(({ title }) =>
        // biome-ignore lint/style/noNonNullAssertion: narrowed by enclosing .length check.
        this.options.libraryTitleFilter!.includes(title),
      );
    }

    return filteredLibraries;
  }

  // Uncached: the provider's `getFiltersCached` wraps this. A direct caller refetches.
  async getAllFilters(): Promise<Required<Meta>> {
    // Movies-only by design; the consumer reads only the movie Type bucket.
    const libraries = (await this.getLibraries()).filter(
      (lib) => lib.type === 'movie',
    );

    // Only Meta is used, but without a container cap Plex ships every section's
    // full item payload to carry it: megabytes per fetch. Container-Size=0
    // returns the container with zero Metadata items. Not every PMS build
    // honours that, hence the fallback below.
    const fetchMeta = (metaOnly: boolean) =>
      fanOutLibraries(libraries, 'getAllFilters', ({ key }) =>
        this.fetch<LibraryItems>(`/library/sections/${key}/all`, {
          searchParams: new URLSearchParams({
            type: '1',
            includeMeta: '1',
            includeAdvanced: '1',
            includeCollections: '1',
            includeExternalMedia: '0',
            ...(metaOnly
              ? { 'X-Plex-Container-Start': '0', 'X-Plex-Container-Size': '0' }
              : {}),
          }),
        }),
      );

    // Meta's arrays are omit-empty like every Plex array field. Guarded so one
    // bare library can't sink a response the others filled.
    const merge = (fulfilled: LibraryItems[]): Required<Meta> => {
      const results: Required<Meta> = { Type: [], FieldType: [] };
      for (const result of fulfilled) {
        if (result.Meta) {
          if (!results.FieldType.length && result.Meta.FieldType?.length) {
            results.FieldType = result.Meta.FieldType;
          }
          results.Type.push(...(result.Meta.Type ?? []));
        }
      }
      return results;
    };

    const metaOnly = merge(await fetchMeta(true));
    if (libraries.length === 0 || metaOnly.Type.length || metaOnly.FieldType.length) {
      return metaOnly;
    }
    // This build withholds Meta under a zero-size container; refetch unpaged
    // rather than ship an empty filter list.
    logger.warn(
      'getAllFilters: zero-size container returned no Meta; retrying with full fetch',
    );
    return merge(await fetchMeta(false));
  }

  async getFilterValues(key: string): Promise<FilterValues & { Directory: FilterValue[] }> {
    // `key` reaches a Plex URL path: `/` or `..` would redirect this
    // token-bearing request to another endpoint. Never trust the caller here.
    if (!/^[a-z0-9_-]+$/i.test(key)) {
      throw new Error(`Invalid filter key: ${JSON.stringify(key)}`);
    }
    // Movie libraries only. A library the filter doesn't apply to (Audiobooks
    // for 'genre') answers 200 OK with Directory omitted, so the merge below
    // stays guarded too: a movie library with no values omits it as well.
    const allLibraries = await this.getLibraries();
    const libraries = allLibraries.filter((lib) => lib.type === 'movie');
    if (libraries.length === 0) {
      throw new Error(`No movie libraries available to fetch filter values for "${key}"`);
    }

    // First fulfilled response seeds the metadata; the rest add Directory entries.
    const fulfilled = await fanOutLibraries(
      libraries,
      `getFilterValues("${key}")`,
      (lib) => this.fetch<FilterValues>(`/library/sections/${lib.key}/${key}`),
    );
    if (fulfilled.length === 0) {
      throw new Error(`Every library section failed when fetching filter values for "${key}"`);
    }

    const [first, ...rest] = fulfilled;
    // Concrete local so the return type can guarantee Directory, which the wire
    // type marks optional.
    const directory: FilterValue[] = first.Directory ? [...first.Directory] : [];
    for (const next of rest) {
      if (next.Directory) {
        directory.push(...next.Directory);
      }
    }
    return { ...first, Directory: directory, size: directory.length };
  }

  async getLibraryItems(
    key: string,
    { filters }: { filters?: URLSearchParams } = {},
  ): Promise<LibraryItems> {
    // Same guard as getFilterValues: `key` reaches a Plex URL path, so `..` and
    // `/` must not pass even though no user input feeds keys today.
    if (!/^[a-z0-9_-]+$/i.test(key)) {
      throw new Error(`Invalid library key: ${JSON.stringify(key)}`);
    }
    // Unpaged, Plex returns the whole library in one response: megabytes on a
    // ~4000-movie library. Each page is its own retryable fetch. Accumulated
    // into one LibraryItems; the consumer wants the full Metadata array plus
    // the fields the first page carries.
    const PAGE_SIZE = 1000;
    let allMetadata: LibraryItems['Metadata'] = [];
    let firstPage: LibraryItems | undefined;
    let start = 0;
    while (true) {
      const pageParams = new URLSearchParams(filters);
      pageParams.set('X-Plex-Container-Start', String(start));
      pageParams.set('X-Plex-Container-Size', String(PAGE_SIZE));
      const page = await this.fetch<LibraryItems>(
        `/library/sections/${key}/all`,
        { searchParams: pageParams },
      );
      if (!firstPage) firstPage = page;
      const items = page.Metadata ?? [];
      allMetadata = allMetadata.concat(items);
      if (items.length < PAGE_SIZE) break;
      start += PAGE_SIZE;
    }
    // biome-ignore lint/style/noNonNullAssertion: the loop always runs once and assigns firstPage.
    return { ...firstPage!, Metadata: allMetadata, size: allMetadata.length };
  }

  // `signal` aborts upstream when the browser disconnects. Combined with an
  // independent timeout so a hung Plex is bounded even if the client stays.
  async getRawThumb(
    key: string,
    signal?: AbortSignal,
  ): Promise<[ReadableStream<Uint8Array>, Headers]> {
    const [metadataId, thumbId] = key.split('/');
    const url = new URL(this.plexUrl.href);
    // Concatenate, don't assign: assigning drops a path prefix on PLEX_URL
    // (host/plex behind a path-routing proxy) and every poster 404s.
    url.pathname = `${url.pathname}/library/metadata/${metadataId}/thumb/${thumbId}`
      .replace(/\/+/g, '/');

    const timeout = AbortSignal.timeout(PLEX_FETCH_TIMEOUT_MS);
    // No Accept header: the response is binary, not JSON.
    const response = await fetch(url.href, {
      headers: await this.buildPlexHeaders(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (response.ok && response.body) {
      return [response.body, response.headers];
    } else {
      // The poster handler logs this; a multi-KB outage page would be logged
      // once per request across the route's per-IP allowance.
      const body = (await response.text()).slice(0, 200);
      throw new Error(`${response.status}: ${body}`);
    }
  }

}
