// Regenerate the PWA icon set from an inline "pin" SVG.
// This is a one-shot dev script; the output PNGs are committed to
// public/ so production builds don't need sharp. Re-run it after
// editing the SVG below.
//
//   node scripts/generate-icons.mjs
//
// Produces (under public/):
//   favicon.svg             — the source SVG, copied verbatim
//   icon-192.png            — 192x192 PWA icon (any purpose)
//   icon-512.png            — 512x512 PWA icon (any purpose)
//   icon-512-maskable.png   — 512x512 with ~84% safe zone for adaptive masks
//   apple-touch-icon.png    — 180x180 iOS home-screen icon
//   favicon-32.png          — small favicon fallback for legacy browsers

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const BG = '#ff6600';
const FG = '#ffffff';

// Pushpin / thumbtack mark. The pin path is Material Symbols
// `push_pin` (filled variant) by Google, Apache 2.0 — the same icon
// family we use for every other header glyph, so the brand mark reads
// as part of the same set.
//
// Material Symbols ship in viewBox 0 -960 960 960; the icon itself is
// a 512×512 square so we scale the pin down and center it on the disc.
// Pin bounding box in Material coords is ~480×800 (centered near
// x=480, y=-440). With scale=0.45 the pin becomes ~216×360, leaving a
// comfortable margin inside the r=250 orange disc. The maskable
// variant scales the pin further (by 0.84) so Android adaptive-icon
// masks can't clip it.
//
// Keep this path in sync with <PinIcon> in src/components/AppHeader.tsx.
const PIN_PATH =
  'm640-480 80 80v80H520v240l-40 40-40-40v-240H240v-80l80-80v-280h-40v-80h400v80h-40v280Z';

function svg({ maskable = false } = {}) {
  const safe = maskable ? 0.84 : 1;
  const scale = 0.45 * safe;
  const frame = maskable
    ? `<rect width="512" height="512" fill="${BG}"/>`
    : `<circle cx="256" cy="256" r="250" fill="${BG}"/>`;
  // translate → scale → translate reads right-to-left: move the pin's
  // geometric center (480, -440) to the origin, scale, then center it
  // on the 512 canvas at (256, 256).
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  ${frame}
  <g transform="translate(256 256) scale(${scale}) translate(-480 440)" fill="${FG}">
    <path d="${PIN_PATH}"/>
  </g>
</svg>`;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, '..', 'public');
  await mkdir(publicDir, { recursive: true });

  const regular = Buffer.from(svg());
  const maskable = Buffer.from(svg({ maskable: true }));

  await writeFile(path.join(publicDir, 'favicon.svg'), regular);
  const rasterize = (src) => sharp(src, { density: 384 });
  await rasterize(regular).resize(32, 32).png().toFile(path.join(publicDir, 'favicon-32.png'));
  await rasterize(regular).resize(180, 180).png().toFile(path.join(publicDir, 'apple-touch-icon.png'));
  await rasterize(regular).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'));
  await rasterize(regular).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'));
  await rasterize(maskable).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512-maskable.png'));

  console.log('Wrote icons to', publicDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
