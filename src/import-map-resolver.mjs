/**
 * Import map resolution following the WICG import maps spec (subset).
 *
 * Supports `imports` (bare specifier → URL) and `scopes` (per-prefix overrides).
 * Used by the Worker to resolve `sandboxImport()` specifiers.
 */

/**
 * Resolve a specifier using an import map.
 *
 * @param {string} specifier - The import specifier (bare or relative).
 * @param {{ imports?: Record<string,string>, scopes?: Record<string,Record<string,string>> }} importMap
 * @param {string} [parentURL] - The URL of the importing module (for scopes).
 * @returns {string|null} Resolved URL or null if no match.
 */
export function resolveWithImportMap(specifier, importMap, parentURL) {
  if (!importMap) return null;

  // Check scopes first (more specific wins)
  if (parentURL && importMap.scopes) {
    // Sort scope keys by length descending — most specific first
    const scopeKeys = Object.keys(importMap.scopes)
      .filter(scope => parentURL.startsWith(scope))
      .sort((a, b) => b.length - a.length);

    for (const scope of scopeKeys) {
      const result = matchSpecifier(specifier, importMap.scopes[scope]);
      if (result !== null) return result;
    }
  }

  // Check top-level imports
  if (importMap.imports) {
    const result = matchSpecifier(specifier, importMap.imports);
    if (result !== null) return result;
  }

  return null;
}

/**
 * Match a specifier against a mapping object.
 * Handles both exact matches and prefix matches (keys ending with '/').
 *
 * @param {string} specifier
 * @param {Record<string,string>} mapping
 * @returns {string|null}
 */
function matchSpecifier(specifier, mapping) {
  // Exact match
  if (mapping[specifier] !== undefined) {
    return mapping[specifier];
  }

  // Prefix match: find the longest key ending with '/' that matches
  let bestKey = null;
  for (const key of Object.keys(mapping)) {
    if (!key.endsWith('/')) continue;
    if (!specifier.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) {
      bestKey = key;
    }
  }

  if (bestKey !== null) {
    const suffix = specifier.slice(bestKey.length);
    return mapping[bestKey] + suffix;
  }

  return null;
}
