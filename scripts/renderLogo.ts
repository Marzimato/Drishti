/**
 * Renders the DRISHTI brand mark to transparent PNGs and an SVG.
 *
 * Run with:  npm run logo
 *
 * The PNGs are rasterised from src/core/brand/logo.ts, so the app icons and the
 * vector source cannot drift apart. sharp renders onto a fully transparent canvas
 * by default, so the background alpha is 0 — verified by the check at the end,
 * which reads back the corner pixel rather than trusting that it worked.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { renderLogoSvg } from '../src/core/brand/logo';

const publicDir = resolve(process.cwd(), 'public');
const iconsDir = resolve(publicDir, 'icons');
mkdirSync(iconsDir, { recursive: true });

interface Target {
  file: string;
  size: number;
  brackets: boolean;
}

const targets: Target[] = [
  { file: resolve(publicDir, 'logo.png'), size: 512, brackets: true },
  { file: resolve(publicDir, 'logo-192.png'), size: 192, brackets: true },
  { file: resolve(iconsDir, 'icon-512.png'), size: 512, brackets: true },
  { file: resolve(iconsDir, 'icon-192.png'), size: 192, brackets: true },
  // Maskable icons need their content inside a safe zone, so no brackets and a
  // tighter eye reads better once the platform crops to a circle.
  { file: resolve(iconsDir, 'icon-maskable-512.png'), size: 512, brackets: false },
];

async function renderPng(target: Target): Promise<void> {
  const svg = renderLogoSvg({ size: target.size, brackets: target.brackets });
  const png = await sharp(Buffer.from(svg), { density: 384 })
    .resize(target.size, target.size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  writeFileSync(target.file, png);

  // Read the alpha of the top-left pixel straight back out. The whole point of
  // this task is a transparent background, so it is asserted, not assumed.
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cornerAlpha = data[info.channels - 1];

  const relative = target.file.replace(process.cwd(), '').replace(/^[\\/]/, '');
  if (cornerAlpha !== 0) {
    throw new Error(`${relative} corner alpha is ${cornerAlpha}, expected 0 (transparent).`);
  }
  console.log(`wrote ${relative} (${target.size}x${target.size}, ${png.length} bytes, corner alpha 0)`);
}

// Also emit the scalable source so the app can use SVG where it can and PNG where
// it must.
writeFileSync(resolve(publicDir, 'logo.svg'), renderLogoSvg({ size: 512, brackets: true }), 'utf8');
console.log('wrote public/logo.svg');

for (const target of targets) {
  await renderPng(target);
}

console.log('');
console.log('All logo assets rendered with transparent backgrounds.');
