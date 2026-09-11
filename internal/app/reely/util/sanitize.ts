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
//
// NFC first: the result is the room-membership key, and without it "José"
// typed precomposed and "José" pasted decomposed are two distinct members whose
// names render identically, so the UsernameTakenError guard never fires. Server
// side only: normalizing the web's per-keystroke sanitizer would fight an IME
// mid-composition, and the server is the one that decides identity.
//
// Trim runs again AFTER the slice: truncating at maxLength can re-expose the
// trailing space the first trim removed, handing back a value that is not a
// fixpoint of this function and that renders identically to the untruncated
// name one character shorter.
export const sanitizeInput = (raw: string, maxLength = 64): string =>
  stripDangerous(raw.normalize('NFC')).trim().slice(0, maxLength).trim();

// Display form: allowlisted and trimmed, case preserved. Empty if nothing
// valid survives.
//
// stripDangerous is no longer redundant now that the allowlist admits every
// Unicode letter: the Hangul fillers are letters that render as blank, so
// without this pass they would ride into a room name and its filename.
export const sanitizeRoomNameDisplay = (raw: string): string =>
  stripDangerous(raw.normalize('NFC'))
    .replace(ROOM_NAME_ALLOWLIST, '')
    .replace(/\s+/g, ' ')  // collapse internal whitespace runs
    .trim()
    .slice(0, ROOM_NAME_MAX_LEN)
    .trim();

// Canonical form: Map key, filename, and URL parameter. Lowercased so
// "Movie Night" and "MOVIE NIGHT" reach the same room. Re-normalized after the
// fold because lowercasing can decompose (U+0130 becomes 'i' + U+0307), and a
// key that is not in normal form is a second room nobody can reach.
export const sanitizeRoomNameCanonical = (raw: string): string =>
  sanitizeRoomNameDisplay(raw).toLowerCase().normalize('NFC');
