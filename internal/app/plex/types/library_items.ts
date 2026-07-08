/// Plex Library Items
/// Path: /library/sections/<section-id>/all
///
/// Wire-level types for the Plex /library responses. Narrowed (audit
/// 15 #370) to the fields actually consumed by api.ts +
/// providers/plex.ts. Pre-prune was 256 lines / ~80% dead; if a
/// future caller needs a wire field we don't currently read, add it
/// here rather than re-introducing the whole shape.

export interface LibraryItems {
  size: number;
  Metadata: LibraryItem[];
  Meta?: Meta;
}

export interface Meta {
  // Optional (audit 16 #444): Plex's omit-empty serialization can drop
  // either array (a Meta object with Type or FieldType absent compiles
  // clean against required fields -- the exact mechanism of the 0.5.23
  // production TypeError). getAllFilters merges into a Required<Meta>,
  // so downstream consumers keep concrete arrays.
  Type?: Type[];
  FieldType?: FieldType[];
}

// Operator suffixes Plex actually emits in filter metadata. Documenting
// the canonical set here (audit 13 #300 + audit 14 #357): the prior
// union included `<<=` (never observed) and `!==` (a TS-side typo --
// Plex uses `!=`). The accurate operator vocabulary across Plex's
// filter responses is: `=` (equals), `!=` (not-equals), `>=` (gte),
// `<=` (lte), `>>=` (after-date / "is after"), and `<<` (before-date,
// no trailing `=`). reely's filter-to-querystring code in `plex/util.
// ts` drops the trailing `=` for URL form -- see the table there.
export interface FieldType {
  type: FilterType;
  Operator: Operator[];
}

interface Operator {
  key: "=" | "!=" | ">=" | "<=" | ">>=" | "<<";
  title: string;
}

interface Type {
  type: ViewGroup;
  Filter?: Filter[];
  Field?: Field[];
}

interface Filter {
  filter: string;
  filterType: FilterType;
  key: string;
  title: string;
}

interface Field {
  key: string;
  type: FilterType;
}

interface LibraryItem {
  ratingKey: string;
  key: string;
  title: string;
  summary: string;
  thumb?: string;
  tagline?: string;
  year?: number;
  duration?: number;
  rating?: number;
  contentRating?: string;
  Genre?: Tag[];
}

interface Tag {
  tag: string;
}

type FilterType =
  | "audioLanguage"
  | "boolean"
  | "date"
  | "integer"
  | "resolution"
  | "string"
  | "subtitleLanguage"
  | "tag";

type ViewGroup =
  | "movie"
  | "show"
  | "episode"
  | "artist"
  | "album"
  | "track"
  | "photo";
