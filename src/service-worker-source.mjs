/**
 * Service Worker source code template for andbox's `service-worker` mode.
 *
 * Returns a string containing the entire Service Worker script. Zero file
 * dependencies at runtime, same rationale as worker-source.mjs's
 * makeWorkerSource(): the script is registered directly as a Service
 * Worker scriptURL, so it can't `import` sibling andbox modules and
 * inlines its own copy of the matching logic in service-worker-response.mjs
 * instead.
 *
 * Unlike makeWorkerSource() (whose output is turned into a `blob:` URL and
 * handed to `new Worker(...)`), this script CANNOT be served from a
 * `blob:` URL -- Service Worker registration requires a real http(s)
 * scriptURL (see andbox#14). The host application is responsible for
 * serving this string's content as a real same-origin file at whatever
 * path it passes as `scriptURL` to `createSandbox({ mode: 'service-worker' })`.
 */

/**
 * Generate the Service Worker source code as a string.
 *
 * The Service Worker supports the following message types from the host
 * (each sent with a `MessagePort` for an ack reply):
 * - `configure`: Replace the entire served-file map
 * - `define`: Add or replace one file
 * - `remove`: Remove one file
 *
 * Lifecycle:
 * - `install`: calls `skipWaiting()` so a new version activates promptly
 *   instead of waiting for all controlled clients to close.
 * - `activate`: calls `clients.claim()` so already-open clients in scope
 *   are taken over without needing a reload. This does NOT by itself fix
 *   the "first navigation" gotcha (see andbox#14) -- a navigation into
 *   `scope` that happens *before* this Service Worker has finished
 *   activating is a normal, unintercepted network request, full stop.
 *   The host-side registration helper (`createSandbox({ mode:
 *   'service-worker' })` in sandbox.mjs) handles this by resolving its
 *   returned promise only once `activate` has completed, and the documented
 *   contract is: don't navigate anything into `scope` until that promise
 *   resolves. Do that, and every request from the very first one is
 *   intercepted, because the registration is already active and matches
 *   `scope` before the navigation request is even made.
 * - `fetch`: in-scope requests matching a known path get a synthesized
 *   Response; everything else (including cross-origin requests, which a
 *   Service Worker can technically see but should not opaquely rewrite)
 *   falls through to the network untouched.
 *
 * @returns {string} The Service Worker script source code.
 */
export function makeServiceWorkerSource() {
  return `
'use strict';

// ── State ──
const files = new Map(); // pathname ('/foo/bar.js') -> { body, contentType, status, headers }

// ── Matching / response synthesis (inlined copy of service-worker-response.mjs) ──
function normalizeScopePath(path) {
  return path.startsWith('/') ? path : '/' + path;
}

function matchFile(pathname) {
  if (files.has(pathname)) return files.get(pathname);
  if (pathname.endsWith('/') && files.has(pathname + 'index.html')) {
    return files.get(pathname + 'index.html');
  }
  if (!pathname.endsWith('/') && files.has(pathname + '/index.html')) {
    return files.get(pathname + '/index.html');
  }
  return null;
}

function makeResponseForFile(entry) {
  if (!entry) return null;
  const headers = new Headers(entry.headers || {});
  if (!headers.has('content-type')) {
    headers.set('content-type', entry.contentType || 'application/octet-stream');
  }
  return new Response(entry.body, { status: entry.status || 200, headers });
}

// ── Lifecycle ──
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  // Claims already-open clients so they're controlled without a reload.
  // Does NOT retroactively intercept a navigation that already completed
  // as a plain network request before this finished -- see the doc
  // comment on makeServiceWorkerSource() in service-worker-source.mjs for
  // the ordering that actually avoids that race.
  event.waitUntil(self.clients.claim());
});

// ── Host <-> SW config protocol ──
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;
  const reply = (payload) => {
    if (event.ports && event.ports[0]) event.ports[0].postMessage(payload);
  };

  switch (msg.type) {
    case 'configure': {
      files.clear();
      for (const [path, entry] of Object.entries(msg.files || {})) {
        files.set(normalizeScopePath(path), entry);
      }
      reply({ type: 'configured' });
      break;
    }
    case 'define': {
      files.set(normalizeScopePath(msg.path), msg.entry);
      reply({ type: 'defined', path: msg.path });
      break;
    }
    case 'remove': {
      files.delete(normalizeScopePath(msg.path));
      reply({ type: 'removed', path: msg.path });
      break;
    }
    default:
      break;
  }
});

// ── Request interception ──
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin requests

  const response = makeResponseForFile(matchFile(url.pathname));
  if (!response) return; // not a known path -- fall through to the network

  event.respondWith(response);
});
`;
}
