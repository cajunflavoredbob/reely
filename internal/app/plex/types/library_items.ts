/// Plex Library Items
/// Path: /library/sections/<section-id>/all
///
/// Narrowed to the fields api.ts and providers/plex.ts actually read. Add a
/// wire field when a caller needs it rather than restoring the full shape.

export interface LibraryItems {
  size: number;
  Metadata: LibraryItem[];
  Meta?: Meta;
}

export interface Meta {
  // Optional because Plex's omit-empty serialization drops either array.
  // getAllFilters merges into a Required<Meta> so consumers get concrete ones.
  Type?: Type[];
  FieldType?: FieldType[];
}

// The Operator union below is the exact set Plex emits: note `<<` (before-date)
// carries no trailing `=`, unlike every other one. plex/util.ts drops the
// trailing `=` for the URL form.
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
