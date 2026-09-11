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

const hash = (chars: string[]): number =>
  chars.reduce((sum, _, i) => (sum + (_.codePointAt(0) ?? 0) * (i + 31)) % 360, 0);

export const userHue = (userName: string): number => {
  // NFC first so a name typed decomposed on one device and precomposed on
  // another hashes the same; spread iterates code points, so an astral
  // character contributes once instead of as two lone surrogates.
  const chars = [...userName.normalize("NFC").toUpperCase()];
  const kept = chars.filter((_) => KEPT_CHAR.test(_));
  // A name made entirely of digits, emoji or punctuation keeps nothing and
  // would reduce to the initial 0, so every such user would share one color.
  // Hash the whole name instead; an empty name still lands on 0.
  return hash(kept.length > 0 ? kept : chars);
};
