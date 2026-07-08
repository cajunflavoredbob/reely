export interface FilterValues {
  size: number;
  allowSync: boolean;
  art: string;
  content: string;
  identifier: string;
  mediaTagPrefix: string;
  mediaTagVersion: number;
  thumb: string;
  title1: string;
  title2: string;
  viewGroup: string;
  viewMode: number;
  // Optional (audit 16 #445): Plex returns 200 OK with this field OMITTED
  // (not []) when a section has no values for the filter -- the 0.5.23
  // production bug. The optional marker makes the compiler enforce the
  // guards the fix added; PlexApi.getFilterValues returns a merged shape
  // with Directory guaranteed concrete.
  Directory?: FilterValue[];
}

export interface FilterValue {
  fastKey: string;
  key: string;
  title: string;
}
