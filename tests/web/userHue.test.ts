import { describe, expect, it } from 'vitest';
import { userHue } from '../../web/app/src/utils/userHue';

// Stable per-username hue for Avatar / UserPill / UsersPopup. Exact outputs
// are pinned because a hash change recolors every avatar in every room and
// breaks recognition mid-session.

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

  // Hyphens count because real usernames have them; stripping would recolor
  // every hyphenated user. Other punctuation and whitespace must not count, so
  // a trailing space never recolors.
  it('keeps hyphens in the hash', () => {
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

  // A failure here means the hash changed and every existing user is about to
  // be recolored. Bump the values only as a deliberate UX decision.
  it('produces the locked-in hue values for representative names', () => {
    expect(userHue('alice')).toBe(29);
    expect(userHue('bob')).toBe(272);
    expect(userHue('kroy')).not.toBe(userHue('k-roy'));
  });
});
