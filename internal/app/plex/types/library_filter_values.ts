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
  // Plex returns 200 OK with this OMITTED, not [], when a section has no
  // values for the filter. Optional so the compiler enforces the guards;
  // PlexApi.getFilterValues returns a merged shape where it is concrete.
  Directory?: FilterValue[];
}

export interface FilterValue {
  fastKey: string;
  key: string;
  title: string;
}
