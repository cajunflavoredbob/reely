# Reely branding assets

`reely-logo.svg` is the single source of truth for the brand mark:

    pnpm gen:brand

That writes four groups of output, and nothing in them is edited by hand:

- the PNG exports in this directory;
- the icon set under `web/app/static/icons/`, including `favicon.ico`;
- `web/app/src/components/atoms/markGeometry.ts`, the geometry module the
  in-app `<Logo>` component draws from;
- the `icons[].src` fields in `web/app/static/manifest.webmanifest`, which
  carry a digest of the icon bytes so an installed PWA picks up new artwork
  (see "Why the manifest is rewritten" below).

`reely-lockup.svg` is the one copy of the mark that is NOT generated. It is
hand-maintained. Every value it shares with the master is asserted, the glyph,
both cards, the fills and the mark gradient, so it cannot drift silently. Its
wordmark gradient is deliberately excluded, since that one is meant to differ.
Edit it by hand when the mark changes.

`tests/web/brandAssets.test.ts` compares the checked-in SVG sources and the
geometry module against the master, so a forgotten regeneration fails CI. It
does not look at the PNGs, `favicon.ico`, or the manifest stamp: librsvg
antialiasing differs across versions, so a byte comparison of raster output
would fail on a runner for reasons unrelated to the brand.

The generator needs ImageMagick built with the librsvg delegate. Check with
`magick -list format | grep SVG`; ImageMagick's own MSVG renderer mangles the
gradients.

| File | Use |
|---|---|
| `reely-logo.svg` | **Master.** Vector source for the square mark: fanned card stack, transparent background, outlined Instrument Serif italic "r" (no font dependency). Edit this one; run `pnpm gen:brand` afterwards. |
| `reely-lockup.svg` | README header lockup: the mark plus an outlined gradient "reely" wordmark. Transparent; one file works on light and dark surfaces, so no `<picture>` variants are needed. **Not generated:** hand-maintained, with every value it shares with the master asserted by `tests/web/brandAssets.test.ts` (its own wordmark gradient excluded, that one is meant to differ). |
| `reely-logo-1000.png` | **Docker Hub repository avatar.** 1000x1000, transparent RGBA. Upload via the Docker Hub web UI (Repository -> Settings -> upload image). Well under the 1 MB cap. |
| `reely-logo-512.png` | Unraid icon URL target and general-purpose export. Transparent. |
| `reely-logo-32-preview.png` | 32x32 stress render verifying the mark holds at the smallest Docker Hub list size. Reference only. |

## Unraid container icon

Unraid's Docker container "Icon URL" field expects a direct PNG URL. Use the
stable raw URL of the 512x512 export:

    https://raw.githubusercontent.com/cajunflavoredbob/reely/main/docs/branding/reely-logo-512.png

Unraid caches icons aggressively. After pasting a new URL, use Settings ->
Docker -> "Force Update Applications" if the icon doesn't refresh.

## Brand notes

- **Mark:** fanned card-stack motif (a hand mid-swipe) with the top card
  carrying the warm coral / sunset gradient that lines up with the app's
  `--ry-*` palette. Back cards are muted terracotta / amber solids
  (`#C96F52` at 55% and `#E39A63` at 75% opacity) chosen to read on both light
  and dark surfaces.
- **Type:** Instrument Serif Italic (the app's display typeface), converted to
  outlined paths in both SVGs, so rendering never depends on the viewer having
  the font.
- **Backgrounds** are transparent everywhere, with one deliberate exception:
  `icon-180.png`, the Apple touch icon, bakes in the app chrome `#0a0604`
  because iOS composites transparency over black.
- **Centring:** the fan leans left, so the drawn geometry sits left of the
  canvas centre. The master applies `translate(51.5 -8)` to centre the rendered
  ink box in the 512 canvas. Change that transform, not the individual shapes.

### The three gradients, and why they differ

All three share the same first two stops. Nothing here is a typo.

| Where | Definition | Why |
|---|---|---|
| Mark, top card | `#FF4E7E` -> `#FF6A4D` @50% -> `#FFB347` | The brand gradient. `objectBoundingBox` units, so it tracks the card's shape. Never use `userSpaceOnUse` with these numbers: it is not equivalent, it shears the axis by the card's 300x420 aspect. |
| App UI (`--ry-grad`) | `#FF4E7E` -> `#FF6A4D` @45% -> `#FFB347`, 135deg | The app-wide gradient, used for the in-app wordmark and the match moment. The earlier midpoint suits the long, thin shapes it fills. |
| Lockup wordmark (`#wg`) | `#FF4E7E` -> `#FF6A4D` @55% -> `#F59B2D` | The README lockup sits on white on GitHub. `#FFB347` is too pale to read as text there, so the wordmark ends on a deeper amber. |

### Why the manifest is rewritten

An installed PWA keeps its launcher icon across upgrades: Chrome's WebAPK update
check diffs manifest fields, not icon bytes, and the icon paths are static. So a
release whose whole point is new artwork changed nothing on any device that had
already installed it. `gen:brand` therefore stamps `icons[].src` with an 8-hex
digest of the icon bytes, which changes exactly when the artwork changes and
never on an unrelated release. A hand-written version string there would be one
more thing to forget.

iOS is not covered: it snapshots the apple-touch-icon at "Add to Home Screen"
and never looks again, so an existing iOS install needs a remove and re-add.

The baked background for `icon-180.png` is read out of that same manifest
(`background_color`) rather than duplicated in the generator, so the two cannot
drift apart.

### Known limitation: no maskable icon

Android's maskable format crops to a circle inscribed in the middle 80% of the
canvas. The mark is drawn large enough that the top card's corners fall outside
that circle at every offset, so a maskable variant cannot be cut from this
artwork without redrawing it smaller. Until that happens the manifest declares
`purpose: "any"` only, and Android composites the transparent icon onto its own
plate.
