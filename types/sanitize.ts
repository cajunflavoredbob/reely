// Shared by the server's internal/app/reely/util/sanitize.ts and the web's
// web/app/src/utils/sanitize.ts so the two sanitizers can't drift.

// Strips characters enabling path traversal, null bytes, control sequences, or
// deceptive display:
//   \x00-\x1f\x7f                       ASCII control characters
//   \u{202A}-\u{202E}\u{2066}-\u{2069}  bidi overrides + isolates
//   \u{200B}-\u{200D}\u{2060}\u{FEFF}   zero-width + word joiner + BOM
//   \.\.                                path traversal sequences
//   [/\\]                               path separators
//
// Bidi overrides and isolates let a name render as something other than what it
// compares as ("evil.exe" shown as "exe.live", or another user's name).
// Zero-width characters do the same by making "alice" + ZWSP + "extra" look
// like "alice" while comparing unequal.
//
// biome-ignore lint/suspicious/noControlCharactersInRegex: defense by design.
export const STRIP_DANGEROUS = /[\x00-\x1f\x7f]|[\u{202A}-\u{202E}\u{2066}-\u{2069}]|[\u{200B}-\u{200D}\u{2060}\u{FEFF}]|\.\.|[/\\]/gu;

// Applies STRIP_DANGEROUS to a fixpoint. One pass is NOT idempotent: stripping
// a character between two dots joins them behind the scan position, so './.',
// '.\x00.', and '.\\.' each yield the '..' the pattern exists to remove. Two
// passes suffice today; the loop keeps that true if the pattern grows new
// multi-character alternatives. Both sanitizers go through this helper.
export const stripDangerous = (raw: string): string => {
  let prev = raw;
  for (;;) {
    const next = prev.replace(STRIP_DANGEROUS, '');
    if (next === prev) return next;
    prev = next;
  }
};

// Letters, digits, spaces, and punctuation that is URL- and filesystem-safe.
// Everything else is stripped; `# ? "` and control bytes are the concerns.
export const ROOM_NAME_ALLOWLIST = /[^a-z0-9 !@$\-_']/gi;

// Enforced server-side by sanitizeRoomNameDisplay; the web input's maxLength
// uses the same value for parity.
export const ROOM_NAME_MAX_LEN = 48;
