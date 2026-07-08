// Shared regex constants used by the server's
// internal/app/reely/util/sanitize.ts and the web's
// web/app/src/utils/sanitize.ts. Centralized here (audit 15 #392) so
// the two sanitizers can't drift -- previously each side maintained
// its own copy of the patterns and they were slightly out of sync on
// flag use (server /gi, web /g) and on whether the strip pass was
// one alternation or five sequential .replace() calls (server got
// the alternation form in audit 15 #380; web stayed on five passes
// until #392 unified them here).

// Strips characters that could enable path traversal, null-byte
// attacks, inject control sequences, or display deceptively:
//   \x00-\x1f\x7f                       ASCII control characters
//   \u{202A}-\u{202E}\u{2066}-\u{2069}  bidi overrides + isolates
//   \u{200B}-\u{200D}\u{2060}\u{FEFF}   zero-width + word joiner + BOM
//   \.\.                                path traversal sequences
//   [/\\]                               path separators
//
// Unicode bidi-override + zero-width characters added in 0.4.20
// (audit 13 #292). The bidi-override set (U+202A LRE, U+202B RLE,
// U+202C PDF, U+202D LRO, U+202E RLO) was used to display "evil.exe"
// as "exe.live" or impersonate another user's display name; the
// directional-isolate set (U+2066-U+2069: LRI, RLI, FSI, PDI) is
// the newer same-family pattern. Zero-width characters (U+200B-D
// ZWSP/ZWNJ/ZWJ, U+FEFF BOM, U+2060 word joiner) make "alice" +
// ZWSP + "extra" visually look like "alice" but compare unequal.
//
// biome-ignore lint/suspicious/noControlCharactersInRegex: defense by design.
export const STRIP_DANGEROUS = /[\x00-\x1f\x7f]|[\u{202A}-\u{202E}\u{2066}-\u{2069}]|[\u{200B}-\u{200D}\u{2060}\u{FEFF}]|\.\.|[/\\]/gu;

// Apply STRIP_DANGEROUS to a fixpoint (audit 16 #440). A single pass is
// NOT idempotent: removing a stripped character that sits between two
// dots brings the dots together after the scan has already passed them,
// so './.', '.\x00.', and '.\\.' each produced the literal '..' the
// pattern exists to remove. One extra pass is provably sufficient (after
// pass one the only removable material left is dot-runs, and a pass over
// a dot-run leaves at most one dot), but loop to the fixpoint anyway --
// it terminates in <= 2 iterations today and can't rot if the pattern
// grows new multi-character alternatives. Both sanitizers (server
// sanitizeInput, web sanitizeUserInput) strip through this helper so
// they can't drift back to the single-pass form.
export const stripDangerous = (raw: string): string => {
  let prev = raw;
  for (;;) {
    const next = prev.replace(STRIP_DANGEROUS, '');
    if (next === prev) return next;
    prev = next;
  }
};

// Room-name allowlist: letters, digits, spaces, and a small set of
// common punctuation that's URL- and filesystem-safe. The /i flag
// covers A-Z and a-z without spelling out the case range. Anything
// outside this set is stripped (`# ? "` and any control bytes are
// the main concerns).
export const ROOM_NAME_ALLOWLIST = /[^a-z0-9 !@$\-_']/gi;

// Cap on canonical room names (server-enforced via
// sanitizeRoomNameDisplay; web inputs use the same value for parity
// via the room-name input element's maxLength attribute).
export const ROOM_NAME_MAX_LEN = 48;
