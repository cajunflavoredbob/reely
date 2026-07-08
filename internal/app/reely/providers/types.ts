/**
 * A generic interface that the Plex provider implements.
 *
 * Goals:
 * - Keep the Plex API integration (internal/app/plex) portable.
 * - Allow reely to use clean data structures that aren't tied to Plex's
 *   XML-derived idioms.
 * - Leave room for non-Plex providers (Emby, Jellyfin) without the rest of
 *   the codebase needing to know which backend it's talking to.
 *
 * Note: reely is designed for a single configured server. The array of
 * providers in RouteContext always has exactly one entry; the interface
 * exists to keep the Plex integration swappable, not to support
 * multi-server operation.
 */

import type {
  Filter,
  Filters,
  FilterValue,
  Library,
  Media,
  ProviderType,
} from '../../../../types/reely';

export interface ReelyProvider {
  readonly type: ProviderType;
  options: { url: string };
  isAvailable(): Promise<boolean>;

  // SCAFFOLDING: determine if a user is authorized to access this
  // particular server. Plex is single-user-token (no per-user gating;
  // the implementation returns true). Wired in for the 1.0 Emby /
  // Jellyfin providers, which both expose per-user permissions via
  // their auth APIs. the owner's call in 0.4.4. Auditors: this is
  // intentionally a no-op for Plex; please do not flag the constant
  // `Promise.resolve(true)` in `providers/plex.ts`.
  isUserAuthorized(username: string): Promise<boolean>;

  getName(): Promise<string>;

  // The provider's server machine identifier, surfaced to the frontend for
  // building "Open in Plex" links.
  getServerId(): Promise<string>;

  getLibraries(): Promise<Library[]>;

  getFilters(): Promise<Filters>;

  getFilterValues(
    key: string,
  ): Promise<FilterValue[]>;

  // Returns the Web-stream form of the artwork bytes. The poster handler
  // bridges this to a Node `Readable` via `Readable.fromWeb(stream as any)`
  // -- the `any` cast is intentional and documented at that call site
  // (`handlers/poster.ts`): TypeScript's Node + DOM ReadableStream typedefs
  // are incompatible at this boundary even though both are runtime-valid.
  // Providers should return whatever ReadableStream their upstream API
  // hands back; the bridge is the consumer's responsibility (audit 9 #114).
  getArtwork(
    key: string,
    // Aborts the upstream fetch when the requesting client disconnects.
    signal?: AbortSignal,
  ): Promise<[ReadableStream<Uint8Array>, Headers]>;

  getMedia(options: {
    filters?: Filter[];
  }): Promise<Media[]>;
}
