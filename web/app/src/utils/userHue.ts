// Stable per-username hue (0-359). Same hash as Avatar so a user's pill, popup
// row, and avatar match. Position-weighted by a small prime so long names
// don't overflow.
//
// Keeps unicode letters and hyphens (real usernames contain them, and dropping
// them would re-color those users). Other punctuation and whitespace go, so
// case and spacing variants don't shift the hue.
//
// No `/g`, which is what makes module scope safe: shared `lastIndex` state
// with `.test()` is a footgun. `/u` is required for `\p{Letter}`.
const KEPT_CHAR = /[\p{Letter}-]/u;

export const userHue = (userName: string): number =>
  userName
    .toUpperCase()
    .split("")
    .filter((_) => KEPT_CHAR.test(_))
    .reduce((sum, _, i) => (sum + _.charCodeAt(0) * (i + 31)) % 360, 0);
