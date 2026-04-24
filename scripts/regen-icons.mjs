// Rasterize public/favicon.svg into the PNG sizes referenced by
// index.html and the PWA manifest. Run manually whenever the SVG
// changes:
//
//   node scripts/regen-icons.mjs
//
// Uses sharp, which is already in node_modules via vite-plugin-pwa's
// transitive deps. No tooling install is required on CI; this is a
// dev-time script that writes into public/ and expects the updated
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
  // safe zone. The filled orange disc fills edge-to-edge, so the crop
  // will never expose transparent corners; the "n" glyph sits well
  // inside the safe zone so it survives aggressive masks.
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
