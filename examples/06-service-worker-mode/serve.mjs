#!/usr/bin/env node
/**
 * 06 — Service Worker mode demo: minimal static file server.
 *
 * Serves this example's static files (index.html, main.mjs) and, since
 * main.mjs does a plain ESM `import '../../src/index.mjs'`, the rest of
 * the andbox library too -- no bundler needed, same as the CDN usage
 * README documents.
 *
 * Also serves the generated Service Worker script at /andbox-sw.js,
 * produced LIVE from makeServiceWorkerSource() on every request -- not a
 * hand-copied static file that could silently drift out of sync with the
 * real generator in src/service-worker-source.mjs.
 *
 * Zero dependencies: node:http/node:fs/node:path/node:url only.
 *
 * Usage:
 *   node examples/06-service-worker-mode/serve.mjs [port]
 * then open the printed URL in a real browser. This can't run headlessly
 * in this repo's CI the way examples/01-05 do -- Node has no Service
 * Worker API at all (see the doc comments in src/service-worker-*.mjs and
 * andbox#14) -- which is also why it is NOT wired into package.json's
 * `examples` script. See examples/README.md.
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeServiceWorkerSource } from '../../src/service-worker-source.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const port = Number(process.argv[2]) || 8787;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);

    // The generated Service Worker script -- served live, not hand-copied.
    if (url.pathname === '/andbox-sw.js') {
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        // Lets the SW control paths outside its own script's own directory
        // (it's served from the repo root here, but /virtual/ is what the
        // demo actually registers as scope).
        'Service-Worker-Allowed': '/',
      });
      res.end(makeServiceWorkerSource());
      return;
    }

    // Everything else: serve as static files from the repo root.
    let requestedPath = url.pathname === '/' ? '/examples/06-service-worker-mode/' : url.pathname;
    if (requestedPath.endsWith('/')) requestedPath += 'index.html';
    const filePath = path.join(repoRoot, requestedPath);

    if (!filePath.startsWith(repoRoot)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const body = await fs.readFile(filePath);
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        `Not found (a real 404 from this dev server, not the andbox Service Worker): ${requestedPath}`
      );
    }
  });
}

// Only start listening when run directly (`node serve.mjs`), not when
// imported (e.g. by a test that wants to exercise createServer() itself).
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(port, () => {
    console.log(
      `andbox service-worker-mode demo: http://localhost:${port}/examples/06-service-worker-mode/`
    );
  });
}
