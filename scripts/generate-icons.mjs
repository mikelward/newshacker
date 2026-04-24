// Rasterize public/favicon.svg into the PNG sizes referenced by
// index.html and the PWA manifest. Run manually whenever the SVG
// changes:
//
//   npm run icons:generate
//
// Uses the repo's direct `sharp` devDependency — if that ever gets
// removed or fails to install, this script will stop working. It's a
// dev-time one-shot: writes into public/, and expects the updated
// PNGs to be committed alongside the SVG change.
//
// Why a script instead of a build step: the icons change rarely and
// the committed PNGs are what Vercel ships. Re-rasterizing on every
// build would be wasted CI time for a file that hasn't moved.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');

// sharp hands the SVG to librsvg, which renders at 72 DPI by default.
// At that density, text glyphs in the source SVG rasterize to an
// intermediate bitmap that's then downscaled — the text ends up
// visibly blurry at favicon sizes. Bumping the input density to 384
// makes the intermediate bitmap large enough that the downscale stays
// sharp for the largest target (512×512). Any higher is wasted work.
const INPUT_DENSITY = 384;

// Android's adaptive icon crops to a circle/squircle with a ~40% safe
// zone. The non-maskable SVG keeps the mark close to the tile edges
// (rounded corners, pill near the bottom), which would expose the
// rounded-corner transparency and clip the pill on aggressive OEM
// launchers — so the maskable target gets its own full-bleed SVG
// with the glyph + pill pulled inside the 80% safe zone.
const TARGETS = [
  { name: 'favicon-32.png', size: 32, source: 'favicon.svg' },
  { name: 'apple-touch-icon.png', size: 180, source: 'favicon.svg' },
  { name: 'icon-192.png', size: 192, source: 'favicon.svg' },
  { name: 'icon-512.png', size: 512, source: 'favicon.svg' },
  { name: 'icon-512-maskable.png', size: 512, source: 'favicon-maskable.svg' },
];

async function main() {
  const svgCache = new Map();
  for (const { name, size, source } of TARGETS) {
    if (!svgCache.has(source)) {
      svgCache.set(source, await readFile(resolve(publicDir, source)));
    }
    const out = resolve(publicDir, name);
    await sharp(svgCache.get(source), { density: INPUT_DENSITY })
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`wrote ${name} (${size}×${size}) from ${source}`);
  }
}

await main();
