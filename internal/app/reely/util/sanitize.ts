// Server-side sanitizers. Pattern constants live in types/sanitize.ts
// (audit 15 #392) so the web's per-keystroke sanitizer can share them
// -- previously each side maintained its own copy and they had drifted
// on flag use + alternation-vs-sequential strip form.
import {
  ROOM_NAME_ALLOWLIST,
  ROOM_NAME_MAX_LEN,
  stripDangerous,
} from '../../../../types/sanitize';

// Applied to user input that touches the filesystem or untrusted code
// paths (usernames). Strips via the shared fixpoint helper (audit 16
// #440 -- a single pass reconstructed '..' from inputs like './.');
// trims and length-caps locally (web omits trim because trimming
// per-keystroke prevents typing spaces).
export const sanitizeInput = (raw: string, maxLength = 64): string =>
  stripDangerous(raw).trim().slice(0, maxLength);

// Display form of a room name -- what the UI shows. Trim and apply the
// allowlist but preserve case. Returns the empty string if the input has
// no valid characters.
export const sanitizeRoomNameDisplay = (raw: string): string =>
  raw
    .replace(ROOM_NAME_ALLOWLIST, '')
    .replace(/\s+/g, ' ')  // collapse internal whitespace runs
    .trim()
    .slice(0, ROOM_NAME_MAX_LEN);

// Canonical form -- used as Map key, filename, and URL parameter value.
// Lowercased so case-variant inputs ("Movie Night" / "MOVIE NIGHT") match
// the same room.
export const sanitizeRoomNameCanonical = (raw: string): string =>
  sanitizeRoomNameDisplay(raw).toLowerCase();
