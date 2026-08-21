import type { Filter } from '../../../../types/reely';

// Bounds chosen to comfortably fit any legitimate Plex filter from the UI while
// preventing a malicious WS message from passing huge strings through to the
// Plex query layer.
const MAX_FILTER_KEY_LEN = 64;
const MAX_FILTER_VALUES = 32;
const MAX_FILTER_VALUE_LEN = 128;

/**
 * Validate one filter before it can reach the Plex query layer.
 *
 * Shared rather than local to the WS handler because filters enter the room
 * from three directions -- applyFilters, a createRoom/joinRoom request, and a
 * persisted room file -- and for a long time only the first was checked. The
 * other two both feed `new Room(req)` -> `room.media` -> the provider query,
 * and the file path replays whatever it holds on every restart, so an unchecked
 * filter written once came back forever.
 */
export const isValidFilter = (f: unknown): f is Filter =>
  f !== null &&
  typeof f === 'object' &&
  typeof (f as Filter).key === 'string' &&
  (f as Filter).key.length > 0 &&
  (f as Filter).key.length <= MAX_FILTER_KEY_LEN &&
  /^[a-z0-9_.-]+$/i.test((f as Filter).key) &&
  typeof (f as Filter).operator === 'string' &&
  // Every operator the UI can send ends with '='. Plex natively emits
  // the date "is before" operator as a bare '<<', but the provider
  // normalizes it to '<<=' before it ships to the client (audit 16
  // #449), so the '='-terminated invariant holds here by construction.
  // filterToQueryString strips the trailing '=' before appending to the
  // key, so a bare '<' or '>' would corrupt to an equality query.
  /^[!<>=~]{0,2}=$/.test((f as Filter).operator) &&
  Array.isArray((f as Filter).value) &&
  (f as Filter).value.length > 0 &&
  (f as Filter).value.length <= MAX_FILTER_VALUES &&
  (f as Filter).value.every(
    (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_FILTER_VALUE_LEN,
  );
