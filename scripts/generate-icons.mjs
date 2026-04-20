// Regenerate the PWA icon set from an inline "n-in-a-circle" SVG.
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
//   icon-512-maskable.png   — 512x512 with ~80% safe zone for adaptive masks
//   apple-touch-icon.png    — 180x180 iOS home-screen icon
//   favicon-32.png          — small favicon fallback for legacy browsers

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const BG = '#ff6600';
const FG = '#ffffff';

// Circle-n mark at viewBox 0 0 512 512. The non-maskable version is an
// orange disc with transparent corners (so the icon reads as circular);
// the maskable version fills the frame with orange and shrinks the ring +
// glyph into an 80% safe zone so nothing is clipped by Android's adaptive
// icon masks.
function svg({ maskable = false } = {}) {
  if (maskable) {
    const safe = 0.84;
    const ringRadius = Math.round(200 * safe);
    const ringStroke = Math.max(10, Math.round(16 * safe));
    const fontSize = Math.round(280 * safe);
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${BG}"/>
  <circle cx="256" cy="256" r="${ringRadius}" fill="none" stroke="${FG}" stroke-width="${ringStroke}"/>
  <text x="50%" y="50%"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        font-weight="700"
        font-size="${fontSize}"
        fill="${FG}">n</text>
</svg>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <circle cx="256" cy="256" r="250" fill="${BG}"/>
  <circle cx="256" cy="256" r="200" fill="none" stroke="${FG}" stroke-width="16"/>
  <text x="50%" y="50%"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        font-weight="700"
        font-size="280"
        fill="${FG}">n</text>
</svg>`;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, '..', 'public');
  await mkdir(publicDir, { recursive: true });

  const regular = Buffer.from(svg());
  const maskable = Buffer.from(svg({ maskable: true }));

  await writeFile(path.join(publicDir, 'favicon.svg'), regular);
  // density bumps librsvg's text rendering density so the glyph stays crisp
  // when downscaled to 32px.
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
