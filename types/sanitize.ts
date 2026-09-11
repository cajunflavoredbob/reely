// Shared by the server's internal/app/reely/util/sanitize.ts and the web's
// web/app/src/utils/sanitize.ts so the two sanitizers can't drift.

// Strips characters enabling path traversal, null bytes, control sequences, or
// deceptive display:
//   \x00-\x1f\x7f                       ASCII control characters
//   \p{Cf}                              every Unicode format character
//   \u{115F}\u{1160}\u{3164}\u{FFA0}    Hangul fillers (letters that render blank)
//   \u{2800}                            braille pattern blank
//   \.\.                                path traversal sequences
//   [/\\]                               path separators
//
// Bidi overrides and isolates let a name render as something other than what it
// compares as ("evil.exe" shown as "exe.live", or another user's name).
// Zero-width characters do the same by making "alice" + ZWSP + "extra" look
// like "alice" while comparing unequal.
//
// \p{Cf} rather than an enumeration of the ranges: format characters are
// invisible by definition, and enumerating them missed LRM/RLM/ALM, the soft
// hyphen and the Mongolian vowel separator, each of which is another way to
// mint a second room member whose name renders identically to the first. The
// four Hangul fillers and the braille blank are NOT format characters (they are
// ordinary letters and a symbol) yet render as nothing, so they are listed out.
//
// biome-ignore lint/suspicious/noControlCharactersInRegex: defense by design.
export const STRIP_DANGEROUS = /[\x00-\x1f\x7f]|\p{Cf}|[\u{115F}\u{1160}\u{3164}\u{FFA0}\u{2800}]|\.\.|[/\\]/gu;

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

// Letters, digits, combining marks, spaces, and punctuation that is URL- and
// filesystem-safe. Everything else is stripped; `# ? "` and control bytes are
// the concerns.
//
// Unicode properties, not [a-z0-9]: an ASCII class deletes every accented and
// non-Latin letter, so the five non-English locales this app ships watch each
// character they type vanish, and "Renee"/"Renée" collapse onto one canonical
// name (which is the Map key AND the room filename). \p{M} keeps combining
// marks so a decomposed sequence survives to be recomposed by the NFC pass in
// sanitizeRoomNameDisplay. Nothing here is unsafe in a POSIX filename: only '/'
// and NUL are, and neither is a letter, digit or mark.
export const ROOM_NAME_ALLOWLIST = /[^\p{L}\p{N}\p{M} !@$\-_']/gu;

// Enforced server-side by sanitizeRoomNameDisplay; the web input's maxLength
// uses the same value for parity.
export const ROOM_NAME_MAX_LEN = 48;

// Filter payload bounds. Well above any real filter from the UI; they stop a
// crafted WS message from pushing huge strings into the Plex query layer.
// Shared rather than server-local so the SPA's filter controls can cap a
// selection before the server rejects the whole payload for one bad row.
export const MAX_FILTER_KEY_LEN = 64;
export const MAX_FILTER_VALUES = 32;
export const MAX_FILTER_VALUE_LEN = 128;
