import type { Filter } from '../../../../types/reely';

// Well above any real filter from the UI; stops a crafted WS message from
// pushing huge strings into the Plex query layer.
const MAX_FILTER_KEY_LEN = 64;
const MAX_FILTER_VALUES = 32;
const MAX_FILTER_VALUE_LEN = 128;

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
