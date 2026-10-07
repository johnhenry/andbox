/**
 * The Node backend of createVirtualModuleRegistry(): mirrors the browser
 * (blob:) registry tests, but because Node cannot import() a blob: URL, the
 * URLs here are andbox-vfs: URLs that Node CAN import(), and virtual files
 * import each other relatively through them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createVirtualModuleRegistry } from '../src/virtual-module-registry.mjs';

describe('node registry — URLs are importable', () => {
  it('auto backend under Node mints importable URLs, one per file', async () => {
    const r = createVirtualModuleRegistry({ 'a.js': 'export const x = 1;', 'b.js': 'export const y = 2;' });
    try {
      const a = r.resolve('a.js');
      assert.doesNotMatch(a, /^blob:/);
      assert.notEqual(a, r.resolve('b.js'));
      assert.equal((await import(a)).x, 1);
      assert.equal((await import(r.resolve('b.js'))).y, 2);
      assert.equal(r.source('a.js'), 'export const x = 1;');
      assert.equal(r.resolve('nope.js'), null);
      assert.equal(r.source('nope.js'), null);
    } finally { r.dispose(); }
  });

  it('relative imports between files work (the multi-hop chain)', async () => {
    const r = createVirtualModuleRegistry({
      'index.js': 'import { add } from "./util.js";\nexport const result = add(2, 3);',
      'util.js': 'import { base } from "./format.js";\nexport function add(a, b) { return a + b + base; }',
      'format.js': 'export const base = 10;',
    });
    try {
      assert.equal((await import(r.resolve('index.js'))).result, 15);
    } finally { r.dispose(); }
  });

  it('nested and ../ relative imports, extensionless and index resolution', async () => {
    const r = createVirtualModuleRegistry({
      'sub/index.js': 'import { x } from "../shared/x.js"; import { y } from "./y"; import { z } from "../lib"; export default x + y + z;',
      'sub/y.js': 'export const y = 20;',
      'shared/x.js': 'export const x = 1;',
      'lib/index.js': 'export const z = 300;',
    });
    try {
      assert.equal((await import(r.resolve('sub/index.js'))).default, 321);
    } finally { r.dispose(); }
  });

  it('cyclic imports work', async () => {
    const r = createVirtualModuleRegistry({
      'a.js': 'import { b } from "./b.js"; export const a = () => "a" + b();',
      'b.js': 'import { a } from "./a.js"; export const b = () => "b"; export const c = () => typeof a;',
    });
    try {
      assert.equal((await import(r.resolve('a.js'))).a(), 'ab');
    } finally { r.dispose(); }
  });

  it('bare specifiers resolve to other registered files, then through the import map', async () => {
    const r = createVirtualModuleRegistry(
      { 'app.js': 'import { u } from "util"; import k from "konst"; export default u + k;', 'util': 'export const u = 4;' },
      { importMap: { imports: { konst: 'data:text/javascript,export default 38' } } },
    );
    try {
      assert.equal((await import(r.resolve('app.js'))).default, 42);
    } finally { r.dispose(); }
  });

  it('an unresolvable relative import fails clearly', async () => {
    const r = createVirtualModuleRegistry({ 'a.js': 'import "./missing.js";' });
    try {
      await assert.rejects(() => import(r.resolve('a.js')), /missing\.js/);
    } finally { r.dispose(); }
  });
});

describe('node registry — define / resolveSpecifier / dispose', () => {
  it('define() registers a new path; redefining mints a new URL with the new code', async () => {
    const r = createVirtualModuleRegistry({ 'a.js': 'export const v = 1;' });
    try {
      const old = r.resolve('a.js');
      const fresh = r.define('a.js', 'export const v = 2;');
      assert.notEqual(old, fresh);
      assert.equal(r.resolve('a.js'), fresh);
      assert.equal((await import(fresh)).v, 2);
      assert.equal(r.source('a.js'), 'export const v = 2;');
      const added = r.define('new.js', 'export const z = 3;');
      assert.equal((await import(added)).z, 3);
    } finally { r.dispose(); }
  });

  it('a dependent sees the redefined dependency on a fresh import', async () => {
    const r = createVirtualModuleRegistry({ 'main.js': 'import { v } from "./dep.js"; export default v;', 'dep.js': 'export const v = 1;' });
    try {
      assert.equal((await import(r.resolve('main.js'))).default, 1);
      r.define('dep.js', 'export const v = 2;');
      r.define('main.js', 'import { v } from "./dep.js"; export default v * 10;');
      assert.equal((await import(r.resolve('main.js'))).default, 20);
    } finally { r.dispose(); }
  });

  it('resolveSpecifier: import map, relative, and unresolved cases', () => {
    const r = createVirtualModuleRegistry(
      { 'sub/index.js': 'export {};', 'sub/util.js': 'export {};', 'shared/x.js': 'export {};' },
      { importMap: { imports: { zod: 'https://esm.sh/zod@3' } } },
    );
    try {
      assert.equal(r.resolveSpecifier('zod', 'sub/index.js'), 'https://esm.sh/zod@3');
      assert.equal(r.resolveSpecifier('./util.js', 'sub/index.js'), r.resolve('sub/util.js'));
      assert.equal(r.resolveSpecifier('../shared/x.js', 'sub/index.js'), r.resolve('shared/x.js'));
      assert.equal(r.resolveSpecifier('./missing.js', 'sub/index.js'), null);
      assert.equal(r.resolveSpecifier('react', 'sub/index.js'), null);
    } finally { r.dispose(); }
  });

  it('paths with spaces and # / ? import fine', async () => {
    const r = createVirtualModuleRegistry({
      'we ird#1?/index.js': 'import { u } from "./util.js"; export default u;',
      'we ird#1?/util.js': 'export const u = 9;',
    });
    try {
      assert.equal((await import(r.resolve('we ird#1?/index.js'))).default, 9);
    } finally { r.dispose(); }
  });

  it('dispose() drops the files, is idempotent, and guards later calls', async () => {
    const r = createVirtualModuleRegistry({ 'a.js': 'export const a = 1;' });
    const url = r.resolve('a.js');
    r.dispose();
    r.dispose();
    assert.equal(r.isDisposed(), true);
    assert.throws(() => r.resolve('a.js'), /disposed/);
    assert.throws(() => r.source('a.js'), /disposed/);
    assert.throws(() => r.define('b.js', ''), /disposed/);
    await assert.rejects(() => import(url + '&fresh=1'));
  });

  it('registries are isolated from each other', async () => {
    const r1 = createVirtualModuleRegistry({ 'a.js': 'export default 1;' });
    const r2 = createVirtualModuleRegistry({ 'a.js': 'export default 2;' });
    try {
      assert.equal((await import(r1.resolve('a.js'))).default, 1);
      assert.equal((await import(r2.resolve('a.js'))).default, 2);
    } finally { r1.dispose(); r2.dispose(); }
  });

  it("backend: 'blob' still gives blob: URLs; unknown backend throws", () => {
    const r = createVirtualModuleRegistry({ 'a.js': 'export {};' }, { backend: 'blob' });
    assert.match(r.resolve('a.js'), /^blob:/);
    r.dispose();
    assert.throws(() => createVirtualModuleRegistry({}, { backend: 'x' }), /Unknown registry backend/);
  });
});
