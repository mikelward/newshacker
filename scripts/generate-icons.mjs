// Regenerate the PWA icon set from an inline "nh" SVG. This is a one-shot
// dev script; the output PNGs are committed to public/ so production builds
// don't need sharp. Re-run it after editing the SVG below (e.g. when we
// replace the placeholder wordmark with a real logo).
//
//   node scripts/generate-icons.mjs
//
// Produces (under public/):
//   favicon.svg             — the source SVG, copied verbatim
//   icon-192.png            — 192x192 PWA icon (any purpose)
//   icon-512.png            — 512x512 PWA icon (any purpose)
//   icon-512-maskable.png   — 512x512 with ~80% safe zone for mask/adaptive
//   apple-touch-icon.png    — 180x180 iOS home-screen icon
//   favicon-32.png          — small favicon fallback for legacy browsers

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const BG = '#f6f6ef';
const FG = '#ff6600';

// "nh" wordmark at viewBox 0 0 512 512. The non-maskable version uses the
// full frame; the maskable version centers the same glyph inside a ~78%
// safe zone so it survives Android's circular/rounded masks.
function svg({ maskable = false } = {}) {
  // Keep the type face chunky enough to read at 48px. The letter path is
  // drawn as text via <text> so we don't ship a font file — we use a
  // system-ish stack with a solid fallback order, then rasterize here with
  // sharp (which uses librsvg/resvg — both render a reasonable default
  // font for "sans-serif"). The final PNG is platform-independent.
  const safe = maskable ? 0.78 : 1;
  const fontSize = Math.round(340 * safe);
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" fill="${BG}"/>
  <text x="50%" y="50%"
        text-anchor="middle"
        dominant-baseline="central"
        font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
        font-weight="800"
        font-size="${fontSize}"
        fill="${FG}"
        letter-spacing="-20">nh</text>
</svg>`;
}

async function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(here, '..', 'public');
  await mkdir(publicDir, { recursive: true });

  const regular = Buffer.from(svg());
  const maskable = Buffer.from(svg({ maskable: true }));

  await writeFile(path.join(publicDir, 'favicon.svg'), regular);
  await sharp(regular).resize(32, 32).png().toFile(path.join(publicDir, 'favicon-32.png'));
  await sharp(regular).resize(180, 180).png().toFile(path.join(publicDir, 'apple-touch-icon.png'));
  await sharp(regular).resize(192, 192).png().toFile(path.join(publicDir, 'icon-192.png'));
  await sharp(regular).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512.png'));
  await sharp(maskable).resize(512, 512).png().toFile(path.join(publicDir, 'icon-512-maskable.png'));

  console.log('Wrote icons to', publicDir);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
