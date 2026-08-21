// Server-side sanitizers. Patterns live in types/sanitize.ts so the web's
// per-keystroke sanitizer shares them instead of drifting.
import {
  ROOM_NAME_ALLOWLIST,
  ROOM_NAME_MAX_LEN,
  stripDangerous,
} from '../../../../types/sanitize';

// For input that touches the filesystem (usernames). stripDangerous runs to a
// fixpoint because one pass reconstructs '..' from inputs like './.'. Trim is
// local: the web omits it, since trimming per keystroke blocks typing spaces.
export const sanitizeInput = (raw: string, maxLength = 64): string =>
  stripDangerous(raw).trim().slice(0, maxLength);

// Display form: allowlisted and trimmed, case preserved. Empty if nothing
// valid survives.
export const sanitizeRoomNameDisplay = (raw: string): string =>
  raw
    .replace(ROOM_NAME_ALLOWLIST, '')
    .replace(/\s+/g, ' ')  // collapse internal whitespace runs
    .trim()
    .slice(0, ROOM_NAME_MAX_LEN);

// Canonical form: Map key, filename, and URL parameter. Lowercased so
// "Movie Night" and "MOVIE NIGHT" reach the same room.
export const sanitizeRoomNameCanonical = (raw: string): string =>
  sanitizeRoomNameDisplay(raw).toLowerCase();
