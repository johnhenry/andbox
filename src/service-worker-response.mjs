/**
 * Pure request-matching / response-synthesis logic for the `service-worker`
 * sandbox mode.
 *
 * Factored out on its own so it's testable under plain Node without a real
 * `ServiceWorkerGlobalScope` (Node has neither `self.clients`,
 * `navigator.serviceWorker`, nor any part of the Service Worker API — see
 * andbox#14). `Response`/`Headers` themselves *are* real Node globals
 * (Node's built-in fetch implementation), so the "given a path and a file
 * map, what Response would the SW's fetch handler return" question is pure
 * logic and gets real coverage here.
 *
 * The generated Service Worker script (`makeServiceWorkerSource()`, in
 * service-worker-source.mjs) inlines an equivalent copy of this matching
 * logic as a self-contained string — the same way worker-source.mjs
 * inlines a copy of resolveWithImportMap() rather than importing it, since
 * the generated script must have zero file dependencies at runtime (it's
 * registered directly as a Service Worker scriptURL, it can't `import`
 * this module across origins/paths the way a bundler-built app could).
 */

/**
 * @typedef {Object} ServedFile
 * @property {string | ArrayBuffer} body
 * @property {string} [contentType]
 * @property {number} [status]
 * @property {Record<string,string>} [headers]
 */

/** Normalize a path to a leading-slash pathname, the way a URL's pathname reads. */
export function normalizeScopePath(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

/**
 * Find the served-file entry for a request pathname, with a directory-index
 * convenience fallback (`/foo/` or `/foo` -> `/foo/index.html`) matching how
 * a real static file server commonly behaves.
 *
 * @param {string} pathname
 * @param {Map<string, ServedFile> | Record<string, ServedFile>} files
 * @returns {ServedFile | null}
 */
export function matchFile(pathname, files) {
  const get = files instanceof Map
    ? (p) => files.get(p)
    : (p) => (Object.prototype.hasOwnProperty.call(files, p) ? files[p] : undefined);

  const direct = get(pathname);
  if (direct !== undefined) return direct;

  if (pathname.endsWith('/')) {
    const indexed = get(pathname + 'index.html');
    if (indexed !== undefined) return indexed;
  } else {
    const indexed = get(pathname + '/index.html');
    if (indexed !== undefined) return indexed;
  }

  return null;
}

/**
 * Synthesize the Response a matched file entry should produce.
 *
 * @param {ServedFile | null} entry
 * @returns {Response | null} null if entry is null (caller should fall through to network)
 */
export function makeResponseForFile(entry) {
  if (!entry) return null;
  const headers = new Headers(entry.headers || {});
  if (!headers.has('content-type')) {
    headers.set('content-type', entry.contentType || 'application/octet-stream');
  }
  return new Response(entry.body, { status: entry.status || 200, headers });
}

/**
 * End-to-end: given a request pathname and the known file map, produce the
 * Response the Service Worker's `fetch` handler would return for an
 * in-scope request, or null if it should fall through to the network.
 *
 * @param {string} pathname
 * @param {Map<string, ServedFile> | Record<string, ServedFile>} files
 * @returns {Response | null}
 */
export function resolveServiceWorkerResponse(pathname, files) {
  const entry = matchFile(normalizeScopePath(pathname), files);
  return makeResponseForFile(entry);
}
