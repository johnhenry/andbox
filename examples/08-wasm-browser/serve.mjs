#!/usr/bin/env node
/**
 * 08 — minimal static server for the browser `mode: 'wasm'` demo.
 * Serves the repo root (so `/src/index.mjs` resolves with no bundler) plus
 * this directory. Zero dependencies.
 *
 *   node examples/08-wasm-browser/build.mjs
 *   node examples/08-wasm-browser/serve.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.argv[2]) || 8788;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === '/') { res.writeHead(302, { Location: '/examples/08-wasm-browser/index.html' }).end(); return; }
  const rel = decodeURIComponent(url.pathname);
  const file = path.join(root, rel);
  if (!file.startsWith(root) || rel.includes('node_modules/..')) { res.writeHead(403).end('forbidden'); return; }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, () => console.log(`http://localhost:${port}/examples/08-wasm-browser/index.html`));
