// Per-keystroke sanitizers. Patterns live in types/sanitize.ts so the server
// shares them and the two sides can't drift.
//
// No trim: trimming per keystroke prevents typing spaces. `maxLength` is taken
// here rather than left to the input attribute, so dropping that attribute
// can't let an over-long string reach the server.
import { ROOM_NAME_ALLOWLIST, stripDangerous } from "../../../../types/sanitize";

export const sanitizeUserInput = (raw: string, maxLength?: number): string => {
  // Fixpoint strip: a single pass reconstructs '..' from input like './.'.
  const cleaned = stripDangerous(raw);
  return maxLength !== undefined ? cleaned.slice(0, maxLength) : cleaned;
};

// Display form (case preserved), applied per keystroke so invalid characters
// never appear. The canonical form is computed server-side.
export const sanitizeRoomNameDisplay = (raw: string, maxLength?: number): string => {
  const cleaned = raw.replace(ROOM_NAME_ALLOWLIST, "");
  return maxLength !== undefined ? cleaned.slice(0, maxLength) : cleaned;
};
