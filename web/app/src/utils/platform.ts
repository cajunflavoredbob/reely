// Platform detection helpers (audit 13 #325). Extracted from inline
// duplicates in Card.tsx and PlexLinks.tsx. Module-level constants
// (not functions) so the userAgent test runs once at import time.

// iOS Safari requires `target="_self"` on external links to actually
// navigate; `target="_blank"` opens a blank tab that never loads (a
// long-running Safari quirk). Other platforms get the standard new-tab
// behavior. Detects iPhone + iPad. iPadOS 13+ reports as "MacIntel" in
// userAgent so this regex misses those; the practical impact is
// limited (links open in a new tab on iPadOS, which is the standard
// behavior elsewhere -- not a regression).
export const isIOS = /(iPhone|iPad)/.test(navigator.userAgent);
