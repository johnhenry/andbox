#!/usr/bin/env node
/**
 * Static server for the browser tests (test/browser/) and example 09.
 * Serves the repo root, so `/src/index.mjs` loads with no bundler. Every
 * response carries `Access-Control-Allow-Origin: *`: the iframe sandbox runs
 * in an opaque origin, so module imports from it are always cross-origin
 * (CORS) requests, exactly as they would be against a CDN. Zero dependencies.
 *
 *   node test/browser/serve.mjs [port]
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.argv[2]) || 47391;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const rel = decodeURIComponent(url.pathname);
  const file = path.join(root, rel);
  if (!file.startsWith(root + path.sep) || rel.includes('node_modules')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await fs.readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }).end('not found');
  }
}).listen(port, '0.0.0.0', () => console.log(`andbox test server on http://127.0.0.1:${port}/`));
