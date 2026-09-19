/**
 * 05 — Virtual module registry resolves a multi-file tree.
 *
 * Demonstrates: createVirtualModuleRegistry() takes a path -> source map,
 * mints a real blob: URL per file, and resolves module specifiers the way
 * `import` would need to -- import-map resolution first, then a relative-
 * path (./util.js, ../shared/x.js) fallback against the known file table,
 * then null for anything genuinely external. An entry module imports a
 * relative util module, which itself imports another relative module one
 * directory over -- the exact "the actual gap #13 is about" case.
 *
 * Runtime note (honest caveat, matching example 04's and data-uri mode's):
 * Blob and URL.createObjectURL()/revokeObjectURL() are real Node >= 24
 * globals, so this example creates real blob: URLs and fetches their real
 * content below. What it does NOT do is import() them -- Node's ESM loader
 * only supports file, data, and node URL schemes (confirmed: import()-ing
 * a blob: URL throws ERR_UNSUPPORTED_ESM_URL_SCHEME), the same restriction
 * examples/README.md already documents for `mode: 'data-uri'`. In a
 * browser, `await import(registry.resolve('entry.js'))` works, but a plain
 * `import "./util.js"` statement inside that source would NOT resolve on
 * its own -- blob: URLs have no hierarchical path for the browser to
 * resolve a relative specifier against (also confirmed by hand: `new
 * URL('./x.js', someBlobURL)` throws "Invalid URL"). That's exactly the
 * gap this registry's resolveSpecifier() fallback closes: call it yourself
 * with the specifier your loader saw and the path of the file that's
 * importing it, and use the URL it returns.
 */

import assert from 'node:assert/strict';
import { createVirtualModuleRegistry } from '../src/index.mjs';

const registry = createVirtualModuleRegistry(
  {
    'entry.js': `
      import { add } from "./math/util.js";
      export const result = add(2, 3);
    `.trim(),
    'math/util.js': `
      import { base } from "../shared/base.js";
      export function add(a, b) { return a + b + base; }
    `.trim(),
    'shared/base.js': 'export const base = 0;',
  },
  {
    // A real npm/CDN import lives alongside the virtual files -- it should
    // resolve via the import map, not get treated as a relative path.
    importMap: { imports: { zod: 'https://esm.sh/zod@3' } },
  }
);

// 1. Every file gets its own real blob: URL with the exact source content.
const entryUrl = registry.resolve('entry.js');
assert.match(entryUrl, /^blob:/);
const entrySource = await (await fetch(entryUrl)).text();
assert.match(entrySource, /import \{ add \} from "\.\/math\/util\.js";/);
console.log('entry.js blob URL:', entryUrl);

// 2. Case 2 -- relative specifiers resolve against the importing file's
//    own directory, hopping across the whole tree.
const utilUrl = registry.resolveSpecifier('./math/util.js', 'entry.js');
assert.equal(utilUrl, registry.resolve('math/util.js'));
console.log('./math/util.js from entry.js ->', utilUrl);

const baseUrl = registry.resolveSpecifier('../shared/base.js', 'math/util.js');
assert.equal(baseUrl, registry.resolve('shared/base.js'));
console.log('../shared/base.js from math/util.js ->', baseUrl);

// 3. Case 1 -- bare specifiers matched by the import map resolve there,
//    entirely delegated to resolveWithImportMap() (not reimplemented).
const zodUrl = registry.resolveSpecifier('zod', 'entry.js');
assert.equal(zodUrl, 'https://esm.sh/zod@3');
console.log('"zod" (import-mapped)      ->', zodUrl);

// 4. Case 3 -- a bare specifier that's neither mapped nor a known relative
//    path is left unresolved (null), not swallowed or guessed at.
const reactUrl = registry.resolveSpecifier('react', 'entry.js');
assert.equal(reactUrl, null);
console.log('"react" (unmapped, external) -> null (caller decides)');

// 5. The blob content really is the right bytes at every hop.
assert.equal(
  await (await fetch(utilUrl)).text(),
  'import { base } from "../shared/base.js";\n      export function add(a, b) { return a + b + base; }'
);
assert.equal(await (await fetch(baseUrl)).text(), 'export const base = 0;');
console.log('OK: fetched blob content matched source at every hop');

// 6. dispose() revokes every blob URL this registry ever minted.
registry.dispose();
await assert.rejects(() => fetch(entryUrl), 'entry.js URL should be revoked after dispose()');
console.log('OK: dispose() revoked all blob URLs');
