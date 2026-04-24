// Rasterize public/favicon.svg into the PNG sizes referenced by
// index.html and the PWA manifest. Run manually whenever the SVG
// changes:
//
//   node scripts/regen-icons.mjs
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
const svgPath = resolve(publicDir, 'favicon.svg');

const TARGETS = [
  { name: 'favicon-32.png', size: 32 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'icon-192.png', size: 192 },
  { name: 'icon-512.png', size: 512 },
  // Android's adaptive icon crops to a circle/squircle with a ~40%
  // safe zone. The maskable variant is rasterized from the same SVG
  // as the other icons, which draws `<circle r="250">` on a 512×512
  // canvas — so there's a ~6 px transparent margin outside the disc
  // that an aggressive crop *can* expose on some OEM launchers. The
  // "n" glyph stays well inside the safe zone, so the letter itself
  // is never clipped. If the transparent corners ever become a real
  // problem, generate the maskable variant from a separate
  // full-bleed SVG rather than sharing the source with favicon.svg.
  { name: 'icon-512-maskable.png', size: 512 },
];

async function main() {
  const svg = await readFile(svgPath);
  for (const { name, size } of TARGETS) {
    const out = resolve(publicDir, name);
    await sharp(svg)
      .resize(size, size)
      .png({ compressionLevel: 9 })
      .toFile(out);
    console.log(`wrote ${name} (${size}×${size})`);
  }
}

await main();
