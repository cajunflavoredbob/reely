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

// The brand mark exists in four places: the master SVG, the favicon SVG, the
// README lockup, and the in-app <Logo>. Before scripts/gen-brand.mjs they were
// four hand-maintained copies, and they drifted on the very first edit -- the
// in-app gradient shipped with different gradientUnits than the icon beside
// it, and nobody could have caught it because no test looked at the artwork.
//
// These assertions are the drift gate. They compare the checked-in SVG sources
// against each other and against the generated geometry module, all of which is
// deterministic text. Rasterised output is deliberately NOT compared: librsvg
// antialiasing differs between versions, so a pixel check would fail on CI
// runners for reasons that have nothing to do with the brand.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const MASTER = 'docs/branding/reely-logo.svg';
const FAVICON = 'web/app/static/icons/icon.svg';
const LOCKUP = 'docs/branding/reely-lockup.svg';

describe('brand assets stay in sync with the master mark', () => {
  it('the favicon SVG is generated from the master, byte for byte', () => {
    // Not "similar": identical. If this fails, someone edited one of the two
    // by hand instead of running `pnpm gen:brand`.
    expect(read(FAVICON)).toBe(read(MASTER));
  });

  it('the generated geometry module matches the master', () => {
    const master = read(MASTER);
    expect(master).toContain(GLYPH_PATH);
    expect(master).toContain(`transform="${GLYPH_TRANSFORM}"`);
    expect(master).toContain(`transform="${MARK_TRANSFORM}"`);
    // Pinned by its gradient fill: the back cards carry byte-identical
    // geometry, so a bare rect match is satisfied by either of them and the
    // top card is never actually asserted.
    expect(master).toContain(
      `<rect x="${CARD.x}" y="${CARD.y}" width="${CARD.width}" height="${CARD.height}" ` +
        `rx="${CARD.rx}" fill="url(#rg)"/>`,
    );
    // Every channel the in-app Logo draws has to come from here. The first
    // version of this gate checked only the transform, glyph path, top card
    // and back-card fills, so a master edit to the viewBox, the gradient
    // direction, the glyph fill, or a back card's own rect regenerated every
    // icon while leaving the component untouched -- the exact silent-drift
    // failure this release exists to fix, one level down, with a green suite.
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
    // The lockup is the one copy the generator does NOT write: it composes the
    // mark with a wordmark, so it stays hand-maintained. That makes it the
    // remaining place silent drift can happen, and checking only the glyph and
    // the top card was not enough -- a master edit to a back-card fill, the
    // gradient stops or the glyph fill regenerated every icon and left this
    // file behind, green. Assert every value it shares with the master.
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
    // The MARK's gradient only. The lockup's second gradient (#wg, for the
    // wordmark) deliberately ends on a deeper amber so the text reads on
    // GitHub's white background; that difference is documented and must not
    // be asserted away.
    const markGradient = lockup.slice(
      lockup.indexOf('<linearGradient id="rg"'),
      lockup.indexOf('</linearGradient>'),
    );
    for (const stop of GRADIENT_STOPS) {
      expect(markGradient).toContain(`offset="${stop.offset}" stop-color="${stop.color}"`);
    }
  });

  it('every SVG names the brand in lowercase for assistive tech', () => {
    // The Unraid template points straight at icon.svg, so its <title> is read
    // aloud as the app's name. "reely" is lowercase everywhere else: the HTML
    // title, the manifest name, the README alt text.
    for (const file of [MASTER, FAVICON, LOCKUP]) {
      expect(read(file)).toContain('<title>reely</title>');
    }
  });

  it('the mark gradient uses objectBoundingBox units in every copy', () => {
    // userSpaceOnUse with the same endpoint numbers is NOT equivalent: the
    // bounding-box form shears the gradient axis by the card's 300x420 aspect.
    // Mixing the two is what made the in-app mark and the favicon disagree.
    for (const file of [MASTER, FAVICON]) {
      expect(read(file)).not.toContain('userSpaceOnUse');
    }
  });
});
