// Stable per-username hue (0-359). Same hash as Avatar so a user's pill,
// popup row, and avatar all land on one color. Linear, position-weighted by
// a small prime so it doesn't overflow for long names.
//
// Filter keeps unicode letters AND hyphens (audit 12 #265): hyphens are
// kept because they show up in real usernames (`k-roy`) and dropping them
// would re-color every existing user with a hyphen mid-session. Other
// punctuation + whitespace are stripped so case / spacing variants don't
// shift the hue.
//
// `/u` (Unicode) is required for `\p{Letter}`; `/g` was carried alongside
// but the regex is only used with `.test()` and is constructed inline per
// call, so the `/g` flag was unnecessary (and `lastIndex` state with `.test`
// is a classic footgun on a shared regex). Dropped in 0.4.6 (audit 10 #170).
//
// Regex hoisted to module scope (audit 13 #336): the prior inline form
// constructed a fresh RegExp per character per call. Module-scope is
// safe here because the regex has no `/g` (no lastIndex state).
const KEPT_CHAR = /[\p{Letter}-]/u;

export const userHue = (userName: string): number =>
  userName
    .toUpperCase()
    .split("")
    .filter((_) => KEPT_CHAR.test(_))
    .reduce((sum, _, i) => (sum + _.charCodeAt(0) * (i + 31)) % 360, 0);
