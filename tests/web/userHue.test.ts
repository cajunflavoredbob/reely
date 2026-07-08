import { describe, expect, it } from 'vitest';
import { userHue } from '../../web/app/src/utils/userHue';

// Stable per-username hue for the Avatar / UserPill / UsersPopup color.
// Pure function: same input -> same output, no state, no globals. The
// tests pin the EXACT output for representative names so a future hash
// change is caught and signals a user-visible recolor of every existing
// avatar in every existing room (a big deal -- the recolor would break
// recognition mid-session).

describe('userHue', () => {
  it('returns a number in [0, 359]', () => {
    for (const name of ['alice', 'bob', 'k-roy', 'taylor-swift-13', 'Z', 'a']) {
      const h = userHue(name);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(360);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('is deterministic (same name -> same hue across calls)', () => {
    expect(userHue('alice')).toBe(userHue('alice'));
    expect(userHue('k-roy')).toBe(userHue('k-roy'));
  });

  it('is case-insensitive (upper/lower of the same name -> same hue)', () => {
    expect(userHue('Alice')).toBe(userHue('alice'));
    expect(userHue('K-ROY')).toBe(userHue('k-roy'));
  });

  // Audit 12 #265 / audit 13 #336: hyphens are KEPT in the hash because
  // real usernames have them (`k-roy`); stripping them would mid-session-
  // recolor every hyphenated user. Other punctuation / whitespace must
  // NOT contribute (so `"alice "` and `"alice"` collide; trailing space
  // shouldn't recolor).
  it('keeps hyphens in the hash (audit 12 #265)', () => {
    // The hyphen is a contributing character, so these MUST differ.
    expect(userHue('kroy')).not.toBe(userHue('k-roy'));
  });

  it('strips whitespace and other punctuation (collides into the bare name)', () => {
    expect(userHue('alice ')).toBe(userHue('alice'));
    expect(userHue('al.ice')).toBe(userHue('alice'));
    expect(userHue('al!ice?')).toBe(userHue('alice'));
  });

  it('returns 0 for an empty string (no characters reduce -> initial acc)', () => {
    expect(userHue('')).toBe(0);
  });

  // Lock the specific hash outputs for representative names. A future
  // refactor that changes any of these would mid-session-recolor every
  // existing user with that name in every existing room (mid-game
  // recognition broken). Test failure here means: bump the locked
  // values, add a CHANGELOG note, and consult on UX.
  it('produces the locked-in hue values for representative names', () => {
    expect(userHue('alice')).toBe(29);
    expect(userHue('bob')).toBe(272);
    // Hyphen contributes; 'kroy' and 'k-roy' must land on different hues.
    expect(userHue('kroy')).not.toBe(userHue('k-roy'));
  });
});
