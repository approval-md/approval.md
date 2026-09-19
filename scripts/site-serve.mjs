#!/usr/bin/env node
// Static server for the site pages in this repo (index.html, /features, /rsi,
// /judgy). Dev only: no caching, no directory listing. Usage:
//   node scripts/site-serve.mjs [port] [--sink]
// --sink additionally accepts POST /sink/<name> and writes the body to
// brand/out/<name> (plain basenames only). brand/render-assets.html uses it to
// drop the rendered icon PNGs and share card where the build script can pick
// them up. Never run with --sink on a port anything else can reach.
import { createServer } from 'node:http';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const args = process.argv.slice(2);
const sink = args.includes('--sink');
const port = Number(args.find((a) => /^\d+$/.test(a)) ?? 8787);
const sinkDir = join(root, 'brand', 'out');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.woff2': 'font/woff2',
};

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (req.method === 'POST' && url.pathname.startsWith('/sink/')) {
    if (!sink) { res.writeHead(405, { 'content-type': 'text/plain' }).end('sink disabled'); return; }
    const name = basename(url.pathname.slice('/sink/'.length));
    if (!/^[\w.-]+\.png$/.test(name)) { res.writeHead(400, { 'content-type': 'text/plain' }).end('png basenames only'); return; }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    await mkdir(sinkDir, { recursive: true });
    await writeFile(join(sinkDir, name), Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'text/plain' }).end(`wrote brand/out/${name}\n`);
    return;
  }
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(root, path);
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`site: http://localhost:${port}/${sink ? ' (sink on: POST /sink/<name>.png -> brand/out)' : ''}`));
