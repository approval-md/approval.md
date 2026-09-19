#!/usr/bin/env node
// Packs PNG files into a favicon.ico (PNG-compressed entries; every current
// browser reads them). Usage:
//   node scripts/build-favicon-ico.mjs out.ico 16.png 32.png 48.png
import { readFileSync, writeFileSync } from 'node:fs';

const [out, ...pngs] = process.argv.slice(2);
if (!out || pngs.length === 0) { console.error('usage: build-favicon-ico.mjs out.ico a.png b.png ...'); process.exit(2); }

const entries = pngs.map((p) => {
  const buf = readFileSync(p);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${p}: not a PNG`);
  const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
  if (w > 256 || h > 256) throw new Error(`${p}: ICO entries are at most 256px`);
  return { buf, w: w === 256 ? 0 : w, h: h === 256 ? 0 : h };
});

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
const dir = Buffer.alloc(16 * entries.length);
let offset = 6 + dir.length;
entries.forEach((e, i) => {
  const o = i * 16;
  dir[o] = e.w; dir[o + 1] = e.h; dir[o + 2] = 0; dir[o + 3] = 0;
  dir.writeUInt16LE(1, o + 4); dir.writeUInt16LE(32, o + 6);
  dir.writeUInt32LE(e.buf.length, o + 8); dir.writeUInt32LE(offset, o + 12);
  offset += e.buf.length;
});
writeFileSync(out, Buffer.concat([header, dir, ...entries.map((e) => e.buf)]));
console.log(`${out}: ${entries.length} entries`);
