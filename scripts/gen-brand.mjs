#!/usr/bin/env node
// Regenerate every derived brand asset from docs/branding/reely-logo.svg.
// tests/web/brandAssets.test.ts asserts the checked-in SVG sources still agree
// with that master.
//
//   pnpm gen:brand
//
// Requires ImageMagick with the librsvg delegate; the internal MSVG renderer
// mangles the gradients.
//
// Raster output is not verified in CI: librsvg antialiasing differs across
// versions, so a byte comparison would fail for no real reason. CI checks the
// SVG geometry, which is deterministic.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MASTER = join(ROOT, "docs/branding/reely-logo.svg");
const ICONS = join(ROOT, "web/app/static/icons");
const BRANDING = join(ROOT, "docs/branding");
const GEOMETRY_TS = join(ROOT, "web/app/src/components/atoms/markGeometry.ts");

const MANIFEST = join(ROOT, "web/app/static/manifest.webmanifest");

// iOS composites apple-touch-icon over black, so transparency reads as a black
// plate; bake the chrome colour in instead. Read from the manifest rather than
// duplicated here, since a second copy would go stale.
const CHROME = JSON.parse(readFileSync(MANIFEST, "utf8")).background_color;
if (typeof CHROME !== "string") {
  throw new Error("gen-brand: manifest.webmanifest has no background_color");
}

const tmp = mkdtempSync(join(tmpdir(), "reely-brand-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

const svg = readFileSync(MASTER, "utf8");

// --- parse the master -------------------------------------------------
// Strict by design: every extractor throws if the master stops matching, so
// geometry cannot drift silently.
const need = (re, label) => {
  const m = svg.match(re);
  if (!m) throw new Error(`gen-brand: cannot find ${label} in ${MASTER}`);
  return m;
};

const viewBox = need(/<svg[^>]*viewBox="([^"]+)"/, "viewBox")[1];
const transform = need(/<g transform="(translate\([^"]+\))">/, "centring transform")[1];
const glyphFill = need(/<path d="[^"]+" fill="(#[0-9A-Fa-f]{3,8})"/, "glyph fill")[1];
const gradient = (() => {
  const [, x1, y1, x2, y2] = need(
    /<linearGradient id="rg" x1="([^"]+)" y1="([^"]+)" x2="([^"]+)" y2="([^"]+)">/,
    "gradient endpoints",
  );
  return { x1, y1, x2, y2 };
})();
const glyphTransform = need(/<g transform="(translate\([^"]+\))"><path/, "glyph transform")[1];
const glyphPath = need(/<path d="([^"]+)"/, "glyph path")[1];

const card = (() => {
  const [, x, y, w, h, rx] = need(
    /<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)" fill="url\(#rg\)"\/>/,
    "top card",
  );
  return { x: +x, y: +y, width: +w, height: +h, rx: +rx };
})();

const backCards = [...svg.matchAll(
  /<g transform="(rotate\([^"]+\))"><rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" rx="(\d+)" fill="(#[0-9A-Fa-f]{6})" opacity="([\d.]+)"\/><\/g>/g,
)].map(([, rotate, x, y, width, height, rx, fill, opacity]) => ({
  rotate,
  rect: { x: +x, y: +y, width: +width, height: +height, rx: +rx },
  fill,
  opacity: +opacity,
}));
if (backCards.length !== 2) throw new Error("gen-brand: expected 2 back cards");

const stops = [...svg.matchAll(/<stop offset="([^"]+)" stop-color="(#[0-9A-Fa-f]{6})"\/>/g)]
  .map(([, offset, color]) => ({ offset, color }));
if (stops.length !== 3) throw new Error("gen-brand: expected 3 gradient stops");

// --- geometry module for the in-app <Logo> ----------------------------
// Logo.tsx renders the mark inline (useId-scoped gradient ids, so two Logos on
// a page can't collide) and imports these rather than keeping its own copy.
const ts = `// GENERATED FILE -- do not edit.
// Produced by scripts/gen-brand.mjs from docs/branding/reely-logo.svg.
// Run \`pnpm gen:brand\` after changing the master; CI fails if this drifts.

export const MARK_VIEWBOX = ${JSON.stringify(viewBox)};
export const MARK_TRANSFORM = ${JSON.stringify(transform)};
export const CARD = ${JSON.stringify(card)} as const;
export const BACK_CARDS = ${JSON.stringify(backCards)} as const;
export const GRADIENT_STOPS = ${JSON.stringify(stops)} as const;
export const GLYPH_TRANSFORM = ${JSON.stringify(glyphTransform)};
export const GLYPH_FILL = ${JSON.stringify(glyphFill)};
export const GRADIENT = ${JSON.stringify(gradient)} as const;
export const GLYPH_PATH =
  ${JSON.stringify(glyphPath)};
`;
writeFileSync(GEOMETRY_TS, ts);

// --- icon.svg ---------------------------------------------------------
// Byte copy of the master, so the favicon and the brand asset can't disagree.
writeFileSync(join(ICONS, "icon.svg"), svg);

// --- rasterisation ----------------------------------------------------
const magick = (...args) => execFileSync("magick", args, { stdio: ["ignore", "pipe", "pipe"] });

// High density then downsample: librsvg rasterises at the requested size, and
// letting it draw small directly loses the glyph's thin strokes.
const png = (out, px, { background } = {}) => {
  const args = [
    "-background", background ?? "none",
    "-density", "600",
    MASTER,
    "-resize", `${px}x${px}`,
    "-depth", "8",
  ];
  // A baked background must actually be flattened, or the PNG keeps an alpha
  // channel and iOS blackens it anyway.
  if (background) args.push("-alpha", "remove", "-alpha", "off");
  args.push("-strip", `png32:${out}`);
  magick(...args);
  return out;
};

png(join(ICONS, "icon-32.png"), 32);
png(join(ICONS, "icon-192.png"), 192);
png(join(ICONS, "icon-512.png"), 512);
png(join(ICONS, "icon-180.png"), 180, { background: CHROME });
png(join(BRANDING, "reely-logo-512.png"), 512);
png(join(BRANDING, "reely-logo-1000.png"), 1000);
png(join(BRANDING, "reely-logo-32-preview.png"), 32);

// --- favicon.ico ------------------------------------------------------
// PNG-compressed frames at full 32-bit alpha; 8bpp paletted with a 1-bit mask
// bands the gradient and floods the larger frames with an opaque backdrop.
const icoFrames = [16, 32, 48].map((px) => ({
  px,
  data: readFileSync(png(join(tmp, `ico-${px}.png`), px)),
}));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(icoFrames.length, 4);

let offset = 6 + 16 * icoFrames.length;
const entries = [];
for (const frame of icoFrames) {
  const e = Buffer.alloc(16);
  e.writeUInt8(frame.px === 256 ? 0 : frame.px, 0);
  e.writeUInt8(frame.px === 256 ? 0 : frame.px, 1);
  e.writeUInt8(0, 2); // palette size: 0 for truecolour
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(frame.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += frame.data.length;
  entries.push(e);
}
writeFileSync(
  join(ICONS, "favicon.ico"),
  Buffer.concat([header, ...entries, ...icoFrames.map((f) => f.data)]),
);

// --- manifest cache-busting stamp -------------------------------------
// Chrome's WebAPK update check diffs manifest fields, not icon bytes, and the
// icon URLs are unversioned, so an installed PWA keeps its old launcher icon
// forever. Stamping src with a digest of the icon bytes makes the manifest
// change exactly when the artwork does, with nothing to remember by hand.
const stamp = createHash("sha256")
  .update(readFileSync(join(ICONS, "icon-192.png")))
  .update(readFileSync(join(ICONS, "icon-512.png")))
  .digest("hex")
  .slice(0, 8);

const manifest = readFileSync(MANIFEST, "utf8").replace(
  /"src": "\.\/icons\/(icon-(?:192|512)\.png)(?:\?v=[^"]*)?"/g,
  `"src": "./icons/$1?v=${stamp}"`,
);
writeFileSync(MANIFEST, manifest);

// Not iOS: it snapshots the apple-touch-icon at add-to-home-screen and never
// looks again, so existing installs need a remove-and-re-add.

// biome-ignore lint/suspicious/noConsole: this is a CLI tool; stdout is its output.
console.log(`brand assets regenerated from docs/branding/reely-logo.svg (icon stamp ${stamp})`);
