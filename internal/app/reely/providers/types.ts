/**
 * Backend-agnostic interface the Plex provider implements. Keeps the Plex
 * integration swappable and its XML-derived idioms out of the rest of the app.
 *
 * reely is single-server: RouteContext's provider array always has one entry.
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

  // SCAFFOLDING for Emby / Jellyfin, which expose per-user permissions. Plex
  // is single-token, so its implementation is intentionally always true.
  isUserAuthorized(username: string): Promise<boolean>;

  getName(): Promise<string>;

  // Server machine identifier; the frontend builds "Open in Plex" links from it.
  getServerId(): Promise<string>;

  getLibraries(): Promise<Library[]>;

  getFilters(): Promise<Filters>;

  getFilterValues(
    key: string,
  ): Promise<FilterValue[]>;

  // Return whatever ReadableStream the upstream API hands back; bridging to a
  // Node Readable is the consumer's job (see handlers/poster.ts, where the
  // Node/DOM typedef mismatch forces an `any` cast).
  getArtwork(
    key: string,
    // Aborts the upstream fetch when the requesting client disconnects.
    signal?: AbortSignal,
  ): Promise<[ReadableStream<Uint8Array>, Headers]>;

  getMedia(options: {
    filters?: Filter[];
  }): Promise<Media[]>;
}
