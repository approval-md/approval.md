#!/usr/bin/env node
// Moves the PNGs that brand/render-assets.html?sink dropped in brand/out/ into
// their served locations at the repo root and packs favicon.ico from the
// 16/32/48 renders. Run after the render page reports every file written:
//   node scripts/site-serve.mjs 8788 --sink   (or the "site-render" launch config)
//   open http://localhost:8788/brand/render-assets.html?sink
//   node scripts/build-site-icons.mjs
import { copyFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const out = join(root, 'brand', 'out');
const need = ['f16.png', 'f32.png', 'f48.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-image.png'];
const missing = need.filter((n) => !existsSync(join(out, n)));
if (missing.length) { console.error(`brand/out is missing: ${missing.join(', ')}. Open /brand/render-assets.html?sink first.`); process.exit(1); }
for (const n of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'og-image.png']) {
  copyFileSync(join(out, n), join(root, n));
  console.log(`wrote ${n}`);
}
execFileSync(process.execPath, [join(root, 'scripts', 'build-favicon-ico.mjs'), join(root, 'favicon.ico'), ...['f16.png', 'f32.png', 'f48.png'].map((n) => join(out, n))], { stdio: 'inherit' });
