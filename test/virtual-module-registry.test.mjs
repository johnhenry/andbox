/**
 * Real behavioral tests for createVirtualModuleRegistry().
 *
 * Unlike the Worker-based sandbox (see test/sandbox.test.mjs — needs a
 * browser Worker, so Node CI can only smoke-test that the module loads),
 * `Blob` and `URL.createObjectURL()`/`revokeObjectURL()` are real globals
 * under Node >= 24 (this repo's engines.node minimum), so blob creation,
 * path-table bookkeeping, and specifier resolution get full real coverage
 * here: every URL below is an actual `blob:` URL, fetched for real via
 * `fetch()` to assert on its actual byte content.
 *
 * One honest caveat, confirmed by hand rather than assumed: Node's ESM
 * loader does not support `import()` of `blob:` URLs at all (only file,
 * data, and node schemes — the same restriction examples/README.md
 * already documents for the existing `data-uri` sandbox mode). So these
 * tests prove the registry's URLs are real and hold the right content by
 * fetching them, not by import()-ing them; an actual `import()` of a
 * registry URL is exercised in a browser, not in this Node suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualModuleRegistry } from '../src/virtual-module-registry.mjs';

async function textAt(url) {
  const res = await fetch(url);
  return res.text();
}

describe('createVirtualModuleRegistry — blob creation and lookup', () => {
  it('mints one real blob: URL per file, holding that file\'s exact content', async () => {
    const registry = createVirtualModuleRegistry({
      'index.js': 'export const x = 1;',
      'util.js': 'export const y = 2;',
    });
    try {
      const indexUrl = registry.resolve('index.js');
      const utilUrl = registry.resolve('util.js');
      assert.match(indexUrl, /^blob:/);
      assert.match(utilUrl, /^blob:/);
      assert.notEqual(indexUrl, utilUrl);
      assert.equal(await textAt(indexUrl), 'export const x = 1;');
      assert.equal(await textAt(utilUrl), 'export const y = 2;');
    } finally {
      registry.dispose();
    }
  });

  it('returns null from resolve() for an unregistered path', () => {
    const registry = createVirtualModuleRegistry({ 'a.js': 'export {};' });
    try {
      assert.equal(registry.resolve('missing.js'), null);
    } finally {
      registry.dispose();
    }
  });

  it('has() and paths() reflect the registered file table', () => {
    const registry = createVirtualModuleRegistry({
      'a.js': 'export {};',
      'b/c.js': 'export {};',
    });
    try {
      assert.equal(registry.has('a.js'), true);
      assert.equal(registry.has('b/c.js'), true);
      assert.equal(registry.has('missing.js'), false);
      assert.deepEqual(registry.paths().sort(), ['a.js', 'b/c.js']);
    } finally {
      registry.dispose();
    }
  });

  it('starts empty when constructed with no files', () => {
    const registry = createVirtualModuleRegistry();
    try {
      assert.deepEqual(registry.paths(), []);
    } finally {
      registry.dispose();
    }
  });
});

describe('createVirtualModuleRegistry — define()', () => {
  it('registers a new path at runtime and returns a fetchable blob: URL', async () => {
    const registry = createVirtualModuleRegistry();
    try {
      const url = registry.define('new.js', 'export const z = 3;');
      assert.match(url, /^blob:/);
      assert.equal(registry.resolve('new.js'), url);
      assert.equal(await textAt(url), 'export const z = 3;');
    } finally {
      registry.dispose();
    }
  });

  it('replacing an existing path revokes the old blob URL and mints a new one', async () => {
    const registry = createVirtualModuleRegistry({ 'a.js': 'export const v = 1;' });
    try {
      const oldUrl = registry.resolve('a.js');
      const newUrl = registry.define('a.js', 'export const v = 2;');

      assert.notEqual(oldUrl, newUrl);
      assert.equal(registry.resolve('a.js'), newUrl);
      assert.equal(await textAt(newUrl), 'export const v = 2;');
      await assert.rejects(() => fetch(oldUrl), 'old URL should be revoked and unfetchable');
    } finally {
      registry.dispose();
    }
  });
});

describe('createVirtualModuleRegistry — resolveSpecifier()', () => {
  it('case 1: resolves a bare specifier via the import map (delegated to resolveWithImportMap)', () => {
    const registry = createVirtualModuleRegistry(
      { 'index.js': 'export {};' },
      { importMap: { imports: { zod: 'https://esm.sh/zod@3' } } }
    );
    try {
      assert.equal(registry.resolveSpecifier('zod', 'index.js'), 'https://esm.sh/zod@3');
    } finally {
      registry.dispose();
    }
  });

  it('case 1: applies a scoped import-map rule matched against the parent file\'s own blob URL', () => {
    const registry = createVirtualModuleRegistry(
      { 'app/index.js': 'export {};' },
      {
        importMap: {
          imports: { zod: 'https://esm.sh/zod@3' },
          // Blob URLs mint a fresh random UUID per registry, so this
          // scope key can't predict the exact URL ahead of construction --
          // but resolveWithImportMap() matches scopes by simple prefix, and
          // every URL this registry mints starts with "blob:", so a "blob:"
          // scope deterministically matches the *actual* minted parent URL.
          // That's what proves parentPath's own blob URL genuinely gets
          // threaded through as parentURL, not just accepted and ignored.
          scopes: { 'blob:': { zod: 'https://esm.sh/zod@4' } },
        },
      }
    );
    try {
      assert.equal(registry.resolveSpecifier('zod', 'app/index.js'), 'https://esm.sh/zod@4');
      // No parentPath -> no parentURL -> nothing for the scope to match
      // against -> falls through to the top-level import.
      assert.equal(registry.resolveSpecifier('zod'), 'https://esm.sh/zod@3');
    } finally {
      registry.dispose();
    }
  });

  it('case 2: resolves a relative specifier against a sibling in the same directory', () => {
    const registry = createVirtualModuleRegistry({
      'index.js': 'import { util } from "./util.js";',
      'util.js': 'export const util = 1;',
    });
    try {
      const resolved = registry.resolveSpecifier('./util.js', 'index.js');
      assert.equal(resolved, registry.resolve('util.js'));
    } finally {
      registry.dispose();
    }
  });

  it('case 2: resolves a nested relative specifier and a parent-directory (../) specifier', () => {
    const registry = createVirtualModuleRegistry({
      'sub/index.js': 'export {};',
      'sub/util.js': 'export {};',
      'shared/x.js': 'export {};',
    });
    try {
      assert.equal(
        registry.resolveSpecifier('./util.js', 'sub/index.js'),
        registry.resolve('sub/util.js')
      );
      assert.equal(
        registry.resolveSpecifier('../shared/x.js', 'sub/index.js'),
        registry.resolve('shared/x.js')
      );
    } finally {
      registry.dispose();
    }
  });

  it('case 2: a registered path containing # or ? is not truncated when resolving against it', () => {
    // parentPath is a map key, not a URL -- a literal '#'/'?' in it must not
    // be parsed as the *base* URL's own fragment/query delimiter, which
    // would silently drop everything after it before relative resolution
    // even runs (andbox#13 review).
    const registry = createVirtualModuleRegistry({
      'weird#hash/index.js': 'export {};',
      'weird#hash/util.js': 'export {};',
      'weird?q/index.js': 'export {};',
      'weird?q/util.js': 'export {};',
    });
    try {
      assert.equal(
        registry.resolveSpecifier('./util.js', 'weird#hash/index.js'),
        registry.resolve('weird#hash/util.js')
      );
      assert.equal(
        registry.resolveSpecifier('./util.js', 'weird?q/index.js'),
        registry.resolve('weird?q/util.js')
      );
    } finally {
      registry.dispose();
    }
  });

  it('case 2: a relative specifier pointing at an unregistered path resolves to null', () => {
    const registry = createVirtualModuleRegistry({ 'index.js': 'export {};' });
    try {
      assert.equal(registry.resolveSpecifier('./missing.js', 'index.js'), null);
    } finally {
      registry.dispose();
    }
  });

  it('case 3: a genuinely external bare specifier is left unresolved, not swallowed', () => {
    const registry = createVirtualModuleRegistry(
      { 'index.js': 'import React from "react";' },
      { importMap: { imports: { zod: 'https://esm.sh/zod@3' } } }
    );
    try {
      assert.equal(registry.resolveSpecifier('react', 'index.js'), null);
      assert.equal(registry.resolveSpecifier('https://esm.sh/react@18', 'index.js'), null);
    } finally {
      registry.dispose();
    }
  });

  it('end-to-end: a multi-hop relative chain resolves at every hop and each blob holds the right bytes', async () => {
    const registry = createVirtualModuleRegistry({
      'index.js': 'import { add } from "./util.js";\nexport const result = add(2, 3);',
      'util.js': 'import { base } from "./format.js";\nexport function add(a, b) { return a + b + base; }',
      'format.js': 'export const base = 0;',
    });
    try {
      const indexUrl = registry.resolve('index.js');
      const utilResolvedFromIndex = registry.resolveSpecifier('./util.js', 'index.js');
      const formatResolvedFromUtil = registry.resolveSpecifier('./format.js', 'util.js');

      assert.equal(utilResolvedFromIndex, registry.resolve('util.js'));
      assert.equal(formatResolvedFromUtil, registry.resolve('format.js'));

      assert.equal(await textAt(indexUrl), 'import { add } from "./util.js";\nexport const result = add(2, 3);');
      assert.equal(
        await textAt(utilResolvedFromIndex),
        'import { base } from "./format.js";\nexport function add(a, b) { return a + b + base; }'
      );
      assert.equal(await textAt(formatResolvedFromUtil), 'export const base = 0;');
    } finally {
      registry.dispose();
    }
  });
});

describe('createVirtualModuleRegistry — dispose()', () => {
  it('revokes every minted blob URL', async () => {
    const registry = createVirtualModuleRegistry({
      'a.js': 'export {};',
      'b.js': 'export {};',
    });
    const urls = registry.paths().map((p) => registry.resolve(p));
    registry.dispose();
    for (const url of urls) {
      await assert.rejects(() => fetch(url), `${url} should be revoked`);
    }
  });

  it('is idempotent', () => {
    const registry = createVirtualModuleRegistry({ 'a.js': 'export {};' });
    registry.dispose();
    assert.doesNotThrow(() => registry.dispose());
    assert.equal(registry.isDisposed(), true);
  });

  it('throws from resolve/resolveSpecifier/define after disposal', () => {
    const registry = createVirtualModuleRegistry({ 'a.js': 'export {};' });
    registry.dispose();
    assert.throws(() => registry.resolve('a.js'), /disposed/);
    assert.throws(() => registry.resolveSpecifier('./a.js', 'index.js'), /disposed/);
    assert.throws(() => registry.define('b.js', 'export {};'), /disposed/);
  });
});
