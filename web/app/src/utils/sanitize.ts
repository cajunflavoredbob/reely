// Web-side per-keystroke sanitizers. Pattern constants live in
// types/sanitize.ts (audit 15 #392) so the server's sanitizers can
// share them -- previously each side maintained its own copy and they
// had drifted on flag use (server /gi, web /g) and on whether the
// strip pass was one alternation or five sequential .replace() calls.
//
// Excludes trim -- trimming on every keystroke prevents typing spaces.
// Length capping accepts an optional `maxLength` rather than relying
// solely on the input element's `maxLength` attribute: if a future
// JSX change ever drops that attribute, the sanitizer still bounds
// the result so an over-long string can't reach the server.
import { ROOM_NAME_ALLOWLIST, stripDangerous } from "../../../../types/sanitize";

export const sanitizeUserInput = (raw: string, maxLength?: number): string => {
  // Fixpoint strip (audit 16 #440): a single pass reconstructed '..'
  // from inputs like './.' -- see stripDangerous in types/sanitize.ts.
  const cleaned = stripDangerous(raw);
  return maxLength !== undefined ? cleaned.slice(0, maxLength) : cleaned;
};

// Display form of a room name (case preserved). Applied per-keystroke
// so invalid characters never appear in the input. The canonical form
// is computed server-side on submit.
export const sanitizeRoomNameDisplay = (raw: string, maxLength?: number): string => {
  const cleaned = raw.replace(ROOM_NAME_ALLOWLIST, "");
  return maxLength !== undefined ? cleaned.slice(0, maxLength) : cleaned;
};
