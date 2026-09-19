/**
 * Virtual module registry — path → blob URL bookkeeping for a set of
 * in-memory files that reference each other by relative path.
 *
 * Generalizes the single-file `new Blob([...]) + URL.createObjectURL()`
 * pattern `createDataUriSandbox()` (src/sandbox.mjs) already uses for its
 * one-file case into a `path → content` table, and reuses
 * `resolveWithImportMap()` (src/import-map-resolver.mjs) for import-map
 * resolution rather than reimplementing it.
 */

import { resolveWithImportMap } from './import-map-resolver.mjs';

/**
 * @typedef {Object} VirtualModuleRegistry
 * @property {(path: string) => string | null} resolve
 * @property {(specifier: string, parentPath?: string) => string | null} resolveSpecifier
 * @property {(path: string, source: string) => string} define
 * @property {(path: string) => boolean} has
 * @property {() => string[]} paths
 * @property {() => void} dispose
 * @property {() => boolean} isDisposed
 */

/**
 * Create a registry of in-memory files, each backed by its own `blob:` URL.
 *
 * @param {Record<string, string>} [files] - path → source text
 * @param {{ importMap?: { imports?: Record<string,string>, scopes?: Record<string,Record<string,string>> } }} [options]
 * @returns {VirtualModuleRegistry}
 */
export function createVirtualModuleRegistry(files = {}, options = {}) {
  const importMap = options.importMap || null;
  const urls = new Map(); // path -> blob: URL
  let disposed = false;

  function blobify(path, source) {
    const blob = new Blob([source], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    urls.set(path, url);
    return url;
  }

  for (const [path, source] of Object.entries(files)) {
    blobify(path, source);
  }

  function assertNotDisposed() {
    if (disposed) throw new Error('Virtual module registry has been disposed');
  }

  /**
   * Get the `blob:` URL registered for a path.
   *
   * @param {string} path
   * @returns {string | null} the blob URL, or null if the path is unknown
   */
  function resolve(path) {
    assertNotDisposed();
    return urls.get(path) ?? null;
  }

  /**
   * Register (or replace) a file at runtime. Replacing an existing path
   * revokes its previous blob URL before minting a new one.
   *
   * @param {string} path
   * @param {string} source
   * @returns {string} the new blob URL
   */
  function define(path, source) {
    assertNotDisposed();
    if (urls.has(path)) URL.revokeObjectURL(urls.get(path));
    return blobify(path, source);
  }

  /** @param {string} path */
  function has(path) {
    return urls.has(path);
  }

  /** @returns {string[]} */
  function paths() {
    return [...urls.keys()];
  }

  /**
   * Resolve a module specifier the way `import` would need to, from the
   * point of view of a given importing file. Checks three cases in order:
   *
   * 1. Import-map resolution (`imports`/`scopes`), delegated entirely to
   *    `resolveWithImportMap()` — the same algorithm the worker-mode
   *    sandbox's `sandboxImport()` uses. `parentPath`'s own blob URL (if
   *    known) is passed through as `parentURL` so scoped rules apply.
   * 2. A plain relative-path fallback (`./x.js`, `../x.js`) resolved
   *    against `parentPath`'s directory and looked up in this registry's
   *    path table. `resolveWithImportMap()` has no notion of "known
   *    files" and returns null for these — this is the actual gap this
   *    registry closes.
   * 3. Unresolved — null. A bare specifier that isn't in the import map
   *    and isn't a known relative path (a real npm/CDN specifier, say)
   *    is left for the caller to handle; this registry does not swallow
   *    it or guess.
   *
   * @param {string} specifier
   * @param {string} [parentPath] - path of the file doing the importing
   * @returns {string | null} a resolved URL, or null if nothing matched
   */
  function resolveSpecifier(specifier, parentPath) {
    assertNotDisposed();

    // 1. Import-map resolution (bare specifiers, prefix matches, scopes).
    const parentURL = parentPath !== undefined ? urls.get(parentPath) : undefined;
    const mapped = resolveWithImportMap(specifier, importMap, parentURL);
    if (mapped !== null) return mapped;

    // 2. Relative-path fallback against the known file table.
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const targetPath = resolveRelativePath(parentPath || '', specifier);
      const url = urls.get(targetPath);
      if (url) return url;
    }

    // 3. Genuinely unresolved (e.g. a real external bare specifier).
    return null;
  }

  /** Revoke every blob URL this registry has ever minted. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear();
  }

  return {
    resolve,
    resolveSpecifier,
    define,
    has,
    paths,
    dispose,
    isDisposed: () => disposed,
  };
}

/**
 * Resolve a relative specifier against the path of the importing file.
 *
 * Virtual module paths aren't real URLs, so this borrows the URL parser's
 * relative-reference algorithm rather than hand-rolling one: parse
 * `parentPath` under a synthetic hierarchical scheme (`vfs:///...`, which,
 * unlike `blob:`, has an explicit — if empty — authority component and so
 * is *not* treated as opaque/"cannot be a base URL"), resolve `specifier`
 * against that, and strip the scheme back off.
 *
 * `parentPath` is a registered map key, not a URL -- it may legitimately
 * contain `#`/`?`/other URL-delimiter characters as literal path text, so
 * each segment is percent-encoded before being embedded in the synthetic
 * base URL (otherwise a `#`/`?` in `parentPath` would be parsed as the
 * *base URL's own* fragment/query, silently truncating everything after it
 * before relative resolution even runs). `specifier` is left as-is: it's
 * resolved with real URL relative-reference semantics on purpose, so a
 * literal `#`/`?` in a specifier is treated as a fragment/query exactly as
 * it would be in a real module specifier or href.
 *
 * @param {string} parentPath
 * @param {string} specifier
 * @returns {string}
 */
function resolveRelativePath(parentPath, specifier) {
  const encodedParent = parentPath.split('/').map(encodeURIComponent).join('/');
  const resolved = new URL(specifier, `vfs:///${encodedParent}`);
  return decodeURIComponent(resolved.pathname.slice(1));
}
