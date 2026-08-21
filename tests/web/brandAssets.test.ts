import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BACK_CARDS,
  CARD,
  GLYPH_FILL,
  GLYPH_PATH,
  GLYPH_TRANSFORM,
  GRADIENT,
  GRADIENT_STOPS,
  MARK_TRANSFORM,
  MARK_VIEWBOX,
} from '../../web/app/src/components/atoms/markGeometry';

// Drift gate for the four copies of the brand mark: master SVG, favicon SVG,
// README lockup, in-app <Logo>. Compares SVG source text, not rasterised
// output: librsvg antialiasing varies by version and would fail CI.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MASTER = 'docs/branding/reely-logo.svg';
const FAVICON = 'web/app/static/icons/icon.svg';
const LOCKUP = 'docs/branding/reely-lockup.svg';

describe('brand assets stay in sync with the master mark', () => {
  it('the favicon SVG is generated from the master, byte for byte', () => {
    // Identical, not similar: a failure means a hand edit, not `pnpm gen:brand`.
    expect(read(FAVICON)).toBe(read(MASTER));
  });

  it('the generated geometry module matches the master', () => {
    const master = read(MASTER);
    expect(master).toContain(GLYPH_PATH);
    expect(master).toContain(`transform="${GLYPH_TRANSFORM}"`);
    expect(master).toContain(`transform="${MARK_TRANSFORM}"`);
    // Matched on its gradient fill: back cards share the same rect geometry,
    // so a bare rect match would never assert the top card.
    expect(master).toContain(
      `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.width}" height="${CARD.height}" ` +
        `rx="${CARD.rx}" fill="url(#rg)"/>`,
    );
    // Every channel the in-app Logo draws. Leave one out and a master edit to
    // it regenerates the icons while the component silently keeps the old value.
    expect(master).toContain(`viewBox="${MARK_VIEWBOX}"`);
    expect(master).toContain(
      `x1="${GRADIENT.x1}" y1="${GRADIENT.y1}" x2="${GRADIENT.x2}" y2="${GRADIENT.y2}"`,
    );
    expect(master).toContain(`fill="${GLYPH_FILL}"`);
    for (const back of BACK_CARDS) {
      expect(master).toContain(
        `transform="${back.rotate}"><rect x="${back.rect.x}" y="${back.rect.y}" ` +
          `width="${back.rect.width}" height="${back.rect.height}" rx="${back.rect.rx}" ` +
          `fill="${back.fill}" opacity="${back.opacity}"`,
      );
    }
    for (const stop of GRADIENT_STOPS) {
      expect(master).toContain(`offset="${stop.offset}" stop-color="${stop.color}"`);
    }
  });

  it('the README lockup draws the same mark as the master', () => {
    // The generator does not write the lockup (it composes mark + wordmark), so
    // assert every value it shares with the master, not just the glyph.
    const lockup = read(LOCKUP);
    expect(lockup).toContain(GLYPH_PATH);
    expect(lockup).toContain(`transform="${GLYPH_TRANSFORM}"`);
    expect(lockup).toContain(
      `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.width}" height="${CARD.height}" ` +
        `rx="${CARD.rx}" fill="url(#rg)"/>`,
    );
    expect(lockup).toContain(`fill="${GLYPH_FILL}"`);
    for (const back of BACK_CARDS) {
      expect(lockup).toContain(
        `transform="${back.rotate}"><rect x="${back.rect.x}" y="${back.rect.y}" ` +
          `width="${back.rect.width}" height="${back.rect.height}" rx="${back.rect.rx}" ` +
          `fill="${back.fill}" opacity="${back.opacity}"`,
      );
    }
    // The mark's gradient only. The lockup's #wg ends on a deeper amber so the
    // wordmark reads on GitHub white; that difference is intended.
    const markGradient = lockup.slice(
      lockup.indexOf('<linearGradient id="rg"'),
      lockup.indexOf('</linearGradient>'),
    );
    for (const stop of GRADIENT_STOPS) {
      expect(markGradient).toContain(`offset="${stop.offset}" stop-color="${stop.color}"`);
    }
  });

  it('every SVG names the brand in lowercase for assistive tech', () => {
    // The Unraid template points at icon.svg, so its <title> is read aloud as
    // the app name. "reely" is lowercase everywhere else.
    for (const file of [MASTER, FAVICON, LOCKUP]) {
      expect(read(file)).toContain('<title>reely</title>');
    }
  });

  it('the mark gradient uses objectBoundingBox units in every copy', () => {
    // userSpaceOnUse with the same endpoints is not equivalent: bounding-box
    // shears the gradient axis by the card's 300x420 aspect. Mixing the two
    // makes copies of the mark disagree.
    for (const file of [MASTER, FAVICON]) {
      expect(read(file)).not.toContain('userSpaceOnUse');
    }
  });
});
