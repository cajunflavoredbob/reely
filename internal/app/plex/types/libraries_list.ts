/// Plex Libraries list
/// Path: /library/sections
///
/// Narrowed to the fields actually consumed. `PlexLibrary` is the raw wire
/// shape; the app-layer equivalent is `Library` in types/reely.ts.

export interface Libraries {
  // Plex's omit-empty serialization drops array fields rather than sending [].
  // Optional so callers must guard.
  Directory?: PlexLibrary[];
}

export type LibraryType = "movie" | "show" | "artist" | "photo";

export interface PlexLibrary {
  key: string;
  title: string;
  type: LibraryType;
}
