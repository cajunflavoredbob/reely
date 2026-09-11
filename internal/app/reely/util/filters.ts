import type { Filter } from '../../../../types/reely';
// Bounds live in the shared module so the SPA's filter controls can cap a
// selection client-side: the server rejects the WHOLE applyFilters payload on
// one over-long row, and a UI that cannot know the limit cannot avoid that.
import {
  MAX_FILTER_KEY_LEN,
  MAX_FILTER_VALUE_LEN,
  MAX_FILTER_VALUES,
} from '../../../../types/sanitize';

/**
 * Validate one filter before it can reach the Plex query layer.
 *
 * Shared, not local to the WS handler: filters reach the provider query from
 * applyFilters, from a createRoom/joinRoom request, and from a persisted room
 * file. All three must be checked, and the file path replays what it holds on
 * every restart, so one unchecked filter would come back forever.
 */
export const isValidFilter = (f: unknown): f is Filter =>
  f !== null &&
  typeof f === 'object' &&
  typeof (f as Filter).key === 'string' &&
  (f as Filter).key.length > 0 &&
  (f as Filter).key.length <= MAX_FILTER_KEY_LEN &&
  /^[a-z0-9_.-]+$/i.test((f as Filter).key) &&
  typeof (f as Filter).operator === 'string' &&
  // Must end with '=': filterToQueryString strips the trailing '=', so a bare
  // '<' or '>' would corrupt into an equality query. The provider normalizes
  // Plex's bare '<<' before it ever reaches the client.
  /^[!<>=~]{0,2}=$/.test((f as Filter).operator) &&
  Array.isArray((f as Filter).value) &&
  (f as Filter).value.length > 0 &&
  (f as Filter).value.length <= MAX_FILTER_VALUES &&
  (f as Filter).value.every(
    (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FILTER_VALUE_LEN,
  );
