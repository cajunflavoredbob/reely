/// Plex Libraries list
/// Path: /library/sections
///
/// Narrowed (audit 15 #385) to the fields actually consumed.
/// Libraries: only `.Directory` is read.
/// PlexLibrary: only `.key`, `.title`, `.type` are read. The
/// renamed-in-0.4.20 distinction from the app-layer `Library`
/// (in types/reely.ts) still holds: this is the raw Plex wire
/// shape; any file importing both used to either shadow one or
/// rely on file scope. Same prune pattern as audit 15 #370
/// (library_items.ts in 0.5.11).

export interface Libraries {
  // Optional (audit 16 #443): Plex's omit-empty serialization drops array
  // fields entirely rather than sending [] (proven on the filter-values
  // endpoint in 0.5.23). A server with zero sections plausibly omits
  // Directory here too; the optional marker forces callers to guard.
  Directory?: PlexLibrary[];
}

export type LibraryType = "movie" | "show" | "artist" | "photo";

export interface PlexLibrary {
  key: string;
  title: string;
  type: LibraryType;
}
