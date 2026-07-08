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

// `language` was a PlexApiOptions field but was never wired through to
// any caller (audit 13 #278). PlexApi was always constructed with no
// language, so the Accept-Language header always fell to `'en'`. The
// premise was wrong in two ways: (1) `language` is per-client (each WS
// connection has its own locale via the setLocale message) but
// PlexApi is shared across all connections in the provider, so a
// single field can't represent it; (2) Plex Media Server returns media
// metadata in the metadata-agent's configured language regardless of
// Accept-Language. The header is mostly cosmetic. Dropped the field +
// header entirely rather than maintain dead scaffolding. reely's UI
// strings are translated locally via the i18n module.
export interface PlexApiOptions {
  libraryTitleFilter?: string[];
}

// Upper bound on any single Plex HTTP request. Without it, a hung or
// unreachable Plex server would leave fetch() pending forever, stalling every
// caller (and poisoning the shared cached promises). Generous enough not to
// false-trip on a large library scan over a LAN.
const PLEX_FETCH_TIMEOUT_MS = 30_000;

// Retry tuning for transient Plex errors (audit 14 #330). GETs are
// idempotent, so retrying on a network blip / brief 5xx is safe. Two
// attempts total (one initial + one retry) keeps a real outage from
// blocking the caller for too long; the exponential backoff bounds
// the worst-case wait. Connect errors (TypeError from fetch) and
// 500-599 responses both qualify; 4xx is a real error and isn't
// retried.
const PLEX_RETRY_ATTEMPTS = 2;
const PLEX_RETRY_BACKOFF_MS = 300;

const isRetryableStatus = (status: number): boolean => status >= 500 && status < 600;

// Allowlist for the configured Plex URL scheme. Without this the
// constructor's `new URL(plexUrl)` would accept `file:`,
// `gopher:`, or any URL the WHATWG parser allows, opening a SSRF
// vector if PLEX_URL is operator-controlled but the value isn't
// scrutinized: a `file:///etc/passwd` would otherwise be a valid
// "Plex server" from the constructor's standpoint, and any
// derived request would read local files (audit 13 #294). Bound
// to http and https only; PLEX_URL's audit-12 #207 scheme-required
// check is the env-loader layer; this is defense-in-depth at the
// API-layer boundary.
const ALLOWED_PLEX_SCHEMES = new Set(['http:', 'https:']);

export class PlexApi {
  plexUrl: URL;
  options: PlexApiOptions;
  private plexToken: string;
  // Stable, deterministic client identifier for X-Plex-Client-Identifier
  // (audit 13 #337). Plex Media Server uses this to recognize "the same
  // client" across requests (mostly for activity logs + per-client
  // settings; reely doesn't use sync). Deterministic-by-URL means: same
  // reely install pointed at the same Plex always reports the same id;
  // pointed at a different Plex, a different id. No file persistence
  // needed. The hash is sha256 over the configured URL, truncated to
  // 32 hex chars -- plenty of entropy for a Plex identifier, much
  // shorter than the full 64.
  private clientIdentifier: string;
  // Capabilities is stable for the lifetime of a Plex instance.
  // Cache the Promise so concurrent first-callers share one fetch;
  // failures clear the slot so a transient outage can recover on the
  // next call. No TTL (per-process lifetime).
  private capabilitiesCache = cachePromise<Capabilities>(() => this.fetch<Capabilities>('/'));
  // serverIdCache pipes through capabilitiesCache (audit 13 #315 /
  // audit 14 #352): both / and /identity return machineIdentifier, so
  // hitting /identity separately was a wasted round-trip. The folded
  // path saves one HTTP request per cold cache cycle and aligns the
  // two values to the same source.
  private serverIdCache = cachePromise<string>(
    () => this.getCapabilities().then((c) => c.machineIdentifier),
  );
  // Short-TTL section-list cache (audit 16 #447). The 0.5.23 fix made
  // getFilterValues call getLibraries per invocation (and #427 did the
  // same for getAllFilters), costing a redundant GET /library/sections
  // round-trip per uncached filter key -- the provider layer's 1-hour
  // librariesCache sits ABOVE this API and isn't visible here. 60s
  // bounds staleness tightly while killing the per-click refetch;
  // cachePromise clears the slot on failure so an outage recovers.
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
    // sha256(plexUrl)[:32] -- see clientIdentifier docstring above.
    this.clientIdentifier = createHash('sha256').update(plexUrl).digest('hex').slice(0, 32);
    // Defense-in-depth: register URL + token redactions here too. The
    // primary registration happens in config/redact.ts during loadConfig
    // (audit 12 #237 + #276; extracted from the validator in 0.4.16),
    // but a test or future code path that constructs PlexApi directly
    // would otherwise log this.plexUrl.href without a redaction entry.
    // addRedaction is idempotent and the cost is one Set check
    // (audit 9 #162).
    addRedaction(plexUrl);
    addRedaction(plexToken);
  }

  // Builds the standard X-Plex-* header set every Plex API request should
  // carry (audit 13 #282 + #337). Token is in the header now, NOT in the
  // URL query string -- the prior pattern leaked the token into every
  // logger.debug('Fetching: ${url.href}') line and into every error body
  // echoed back by Plex. Token redaction in logs is still in place as
  // defense-in-depth (constructor's addRedaction), but the header form
  // means there's nothing to redact in the first place. Plex Media
  // Server accepts the header form on every endpoint reely hits
  // (verified against python-plexapi's reference implementation, which
  // uses the header form as its primary auth path). The
  // X-Plex-Client-Identifier / Product / Version triple closes the
  // "Plex may rate-limit or refuse anonymous clients" concern from
  // #337 by identifying reely to the server.
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
      // URLSearchParams (not Record<string,string>) so callers can pass
      // multi-value query params with repeated keys -- needed by the
      // filter-as-query-string path where a single Plex filter can carry
      // multiple selected values (genre=Action&genre=Drama).
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

    // Path only, not the full url.href (audit 13 #329). url.href would
    // include every filter searchParam, padding the log line with a
    // verbose query string that the caller's stack trace doesn't help
    // debug. The token rides in headers now (0.4.20 #282), but path-
    // only also keeps debug logs from echoing other operator-supplied
    // filter values (genre, year) verbatim.
    logger.debug(`Plex fetch: ${url.pathname}`);

    // Retry idempotent GETs on transient errors (audit 14 #330). Plex
    // is generally reliable on the LAN but a brief 503 mid-scan
    // shouldn't poison the cached promise -- the next call would just
    // observe the same failure. Built the headers once; reused per
    // attempt so the X-Plex-Version is consistent.
    const headers = {
      accept: 'application/json',
      ...(await this.buildPlexHeaders()),
    };
    let req: Response | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < PLEX_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 300ms, 600ms, ... The total wait stays
        // bounded by PLEX_RETRY_ATTEMPTS so a real outage surfaces
        // quickly.
        await new Promise((r) => setTimeout(r, PLEX_RETRY_BACKOFF_MS * 2 ** (attempt - 1)));
        logger.debug(`Plex fetch retry ${attempt}: ${url.pathname}`);
      }
      try {
        req = await fetch(url.href, {
          headers,
          signal: AbortSignal.timeout(PLEX_FETCH_TIMEOUT_MS),
        });
        // Retry on 5xx; 4xx is a real error (or our bug) -- don't retry.
        if (req.ok || !isRetryableStatus(req.status)) break;
        lastError = new Error(`Plex API ${req.status} (retryable)`);
      } catch (err) {
        // Network-level failure (fetch threw): retry.
        lastError = err;
      }
    }
    if (!req) {
      // Every attempt threw at the network layer (no Response object).
      throw new Error(
        `Plex fetch failed after ${PLEX_RETRY_ATTEMPTS} attempts`,
        { cause: lastError },
      );
    }

    if (!req.ok) {
      // Truncate the error body (audit 12 #261). Plex error responses can
      // be HTML pages echoing the request URL; with the token now in the
      // header (audit 13 #282) it doesn't ride in url.href, but the
      // truncation still bounds payload size and keeps a multi-KB error
      // page from hijacking a log line.
      const body = (await req.text()).slice(0, 200);
      throw new Error(`Plex API error ${req.status}: ${body}`);
    }

    try {
      const data: PlexMediaContainer<T> = await req.json();
      return data.MediaContainer;
    } catch (err) {
      // Preserve the original error as `cause` so the logger sees the
      // underlying JSON / stream error message + stack, not just the
      // generic wrapper (audit 9 #157).
      throw new Error('Failed to parse Plex API response', { cause: err });
    }
  }

  async isAvailable(): Promise<boolean> {
    // Don't gate on .size -- that's the count of returned capability records
    // and is legitimately 0 on a Plex server with no libraries yet. Use the
    // presence of `machineIdentifier` instead, which every Plex response
    // root carries regardless of library count.
    return typeof (await this.getCapabilities()).machineIdentifier === 'string';
  }

  // getIdentity() was dropped in 0.4.20 (audit 13 #315 / audit 14 #352):
  // both / (capabilities) and /identity return machineIdentifier, so the
  // separate endpoint was a wasted round-trip. serverIdCache now pipes
  // through capabilitiesCache for both values.

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
    // Guard the omit-empty shape (audit 16 #443): a zero-section server
    // plausibly omits Directory entirely, and the unguarded .length read
    // threw a TypeError that sank the libraries cache and preempted the
    // designed "No movie libraries available" error downstream.
    const dirs = sections.Directory ?? [];
    if (dirs.length === 0) {
      return [];
    }

    let filteredLibraries = dirs;

    if (this.options.libraryTitleFilter?.length) {
      filteredLibraries = filteredLibraries.filter(({ title }) =>
        // Non-null narrowing across the .length check above; biome doesn't
        // follow the closure capture so we assert the narrowing explicitly.
        // biome-ignore lint/style/noNonNullAssertion: narrowed by enclosing .length check.
        this.options.libraryTitleFilter!.includes(title),
      );
    }

    return filteredLibraries;
  }

  // No api-layer cache here: the provider wraps this in `getFiltersCached`
  // (via `memo`), so every legitimate caller already hits the provider's
  // cache. A future direct caller of `api.getAllFilters` would refetch --
  // intentional (it's an escape hatch); just be aware.
  async getAllFilters(): Promise<Required<Meta>> {
    // Movie libraries only (audit 16 #427), consistent with the 0.5.23
    // getFilterValues fix below -- reely is movies-only by design, and the
    // consumer (getFiltersCached) reads only the movie Type bucket anyway.
    const libraries = (await this.getLibraries()).filter(
      (lib) => lib.type === 'movie',
    );

    // Only the Meta block is consumed from these responses. Without a
    // container cap, Plex returns the FULL item payload of every section
    // just to carry that block -- the same megabytes-per-fetch cost
    // getLibraryItems documents (audit 13 #296), paid on the first
    // requestFilters of every process (and EVERY one in dev, where memo is
    // a passthrough). X-Plex-Container-Size=0 asks for the container --
    // including Meta -- with zero Metadata items. Plex's own web client
    // uses the same form for count-only queries; the fallback below covers
    // any server version that disagrees. (audit 16 #427)
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

    // Guarded merge (audit 16 #444): Meta's arrays are omit-empty-prone
    // like every other Plex array field, and this merge runs AFTER
    // fanOutLibraries' per-library error tolerance -- an unguarded read
    // here would sink the entire filter response even when other
    // libraries returned good data. Returns Required<Meta> so consumers
    // keep concrete arrays.
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
    // Safety net: a PMS build that withholds Meta under a zero-size
    // container would leave the filter list empty. Retry once with the
    // pre-#427 unpaged form rather than silently shipping no filters.
    logger.warn(
      'getAllFilters: zero-size container returned no Meta; retrying with full fetch',
    );
    return merge(await fetchMeta(false));
  }

  async getFilterValues(key: string): Promise<FilterValues & { Directory: FilterValue[] }> {
    // Defense in depth: `key` is interpolated into a Plex API URL path. The
    // WS handler already allowlists it, but the API layer must not trust its
    // caller -- a key with path separators or `..` could redirect this
    // token-bearing request to a different Plex endpoint (SSRF). A key
    // matching this charset cannot contain `/` or `.`, so no traversal.
    if (!/^[a-z0-9_-]+$/i.test(key)) {
      throw new Error(`Invalid filter key: ${JSON.stringify(key)}`);
    }
    // Audit 17 / 0.5.23 production bug: pre-fix this fanned out to EVERY
    // library section (movies + TV + music + audiobooks). Plex returns
    // 200 OK with an OMITTED Directory field when a non-applicable
    // library has no values for the requested filter (Audiobooks for
    // 'genre', Anime 4K for 'genre' when empty, etc.) -- the subsequent
    // merge hit `merged.Directory.push(...next.Directory)` with
    // `next.Directory === undefined`, throwing TypeError. The throw
    // surfaced as requestFilterValuesError to the client, which set
    // filterValues[key] to [] and rendered free-text SearchControl
    // instead of the picker. Reely is movies-only by design (audit 8
    // #127) so filter to movie libraries here; also defensively guard
    // the Directory merge against Plex omitting the field even on a
    // movie library that legitimately has no values.
    const allLibraries = await this.getLibraries();
    const libraries = allLibraries.filter((lib) => lib.type === 'movie');
    if (libraries.length === 0) {
      throw new Error(`No movie libraries available to fetch filter values for "${key}"`);
    }

    // Per-library fan-out via shared helper (audit 13 #326). First
    // fulfilled response seeds the metadata; the rest contribute
    // Directory entries.
    const fulfilled = await fanOutLibraries(
      libraries,
      `getFilterValues("${key}")`,
      (lib) => this.fetch<FilterValues>(`/library/sections/${lib.key}/${key}`),
    );
    if (fulfilled.length === 0) {
      throw new Error(`Every library section failed when fetching filter values for "${key}"`);
    }

    const [first, ...rest] = fulfilled;
    // Build the merged Directory as a concrete local so the return shape
    // can guarantee it even now that the wire type marks it optional
    // (audit 16 #445 -- the compiler enforces the omit-empty guards).
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
    // Defense in depth: `key` is interpolated into a Plex API URL path
    // (audit 13 #295). Mirrors the validation in `getFilterValues`. Real
    // library keys from `getLibraries()` are short digit-ish identifiers
    // (e.g. "1", "2"); the WS / handler layer doesn't surface keys to
    // user input today, but rejecting `..` / `/` / control chars at the
    // API boundary is the right place to enforce it so a future caller
    // can't accidentally route a Plex-token-bearing request to an
    // unintended endpoint. `async` so the throw surfaces as a rejected
    // promise -- consistent with how `getFilterValues` surfaces the
    // same error class.
    if (!/^[a-z0-9_-]+$/i.test(key)) {
      throw new Error(`Invalid library key: ${JSON.stringify(key)}`);
    }
    // Page through the library section (audit 13 #296). Without paging,
    // Plex returns the entire library in one response: on the owner's
    // ~4000-movie library that's megabytes per fetch held in memory
    // during the JSON parse + the transform pass in the provider.
    // Plex supports X-Plex-Container-Start / X-Plex-Container-Size
    // either as headers or as query params; using query params keeps
    // the call shape consistent with the existing filter-as-searchParams
    // pattern.
    //
    // PAGE_SIZE 1000 picks a middle ground: 4 round-trips for ~4000
    // movies (vs 1 today) but each ~500KB instead of ~2MB. Each round-
    // trip is its own retry-able fetch (audit 14 #330) so a brief 5xx
    // mid-pagination doesn't sink the whole library load.
    //
    // Returns a single accumulated LibraryItems: the consumer
    // (providers/plex.ts getMediaCached) doesn't care that we paged,
    // it just wants the full Metadata array + the metadata fields the
    // first page carries.
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
    // firstPage is guaranteed non-undefined: the while loop above runs
    // at least once (the first fetch happens unconditionally), and
    // every successful fetch assigns firstPage. The non-null assertion
    // matches that invariant without a redundant runtime check.
    // biome-ignore lint/style/noNonNullAssertion: invariant from while loop above.
    return { ...firstPage!, Metadata: allMetadata, size: allMetadata.length };
  }

  // `signal` lets the caller (the poster handler) abort the upstream fetch
  // when the browser disconnects. It is combined with an independent request
  // timeout so a hung Plex server is still bounded even if the client stays.
  async getRawThumb(
    key: string,
    signal?: AbortSignal,
  ): Promise<[ReadableStream<Uint8Array>, Headers]> {
    const [metadataId, thumbId] = key.split('/');
    const url = new URL(this.plexUrl.href);
    // Concatenate onto the configured pathname the same way fetch<T> does
    // (audit 16 #448). The prior pathname ASSIGNMENT discarded any path
    // prefix on PLEX_URL (e.g. http://host/plex behind a path-routing
    // reverse proxy), so every JSON endpoint worked while every poster
    // 404'd -- a confusing partial failure.
    url.pathname = `${url.pathname}/library/metadata/${metadataId}/thumb/${thumbId}`
      .replace(/\/+/g, '/');

    const timeout = AbortSignal.timeout(PLEX_FETCH_TIMEOUT_MS);
    // Token is in the header (audit 13 #282), not the URL. Same headers
    // bundle as the JSON fetch path -- Plex's thumb endpoint accepts
    // the header form (verified via python-plexapi's reference pattern
    // for binary content like /art and /thumb). Accept header omitted:
    // the response is binary (image/jpeg, image/png), not JSON.
    const response = await fetch(url.href, {
      headers: await this.buildPlexHeaders(),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });

    if (response.ok && response.body) {
      return [response.body, response.headers];
    } else {
      // Truncate the upstream body like fetch<T> does (audit 12 #261 /
      // audit 16 #442): the poster handler logs this error, and a proxy
      // or outage page can be multi-KB of HTML -- multiplied by the
      // poster route's per-IP allowance during an outage.
      const body = (await response.text()).slice(0, 200);
      throw new Error(`${response.status}: ${body}`);
    }
  }

}
