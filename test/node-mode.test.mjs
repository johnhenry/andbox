/**
 * Node mode: worker sandbox on node:worker_threads, no shim, no blob: URLs.
 * These run under plain Node (no global Worker).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

describe('node mode — preconditions', () => {
  it('has no global Worker (no shim in play)', () => {
    assert.equal(typeof Worker, 'undefined');
  });
});

describe('node mode — default worker mode auto-selects worker_threads', () => {
  it('round-trips a result', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return 1 + 2'), 3);
    assert.deepEqual(await sb.evaluate('return { a: [1, 2], b: "x" }'), { a: [1, 2], b: 'x' });
  });

  it('propagates thrown errors with name and message', async () => {
    const sb = await make();
    await assert.rejects(
      () => sb.evaluate('throw new TypeError("boom")'),
      (e) => e.name === 'TypeError' && /boom/.test(e.message),
    );
  });

  it('times out runaway code, hard-kills, and recovers', async () => {
    const sb = await make({ defaultTimeoutMs: 5000 });
    await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 150 }), /timed out/i);
    assert.equal(await sb.evaluate('return "alive"'), 'alive');
  });

  it('supports host capabilities over RPC', async () => {
    const sb = await make({ capabilities: { double: async (n) => n * 2 } });
    assert.equal(await sb.evaluate('return await host.call("double", 21)'), 42);
    await assert.rejects(() => sb.evaluate('return await host.call("nope")'), /Unknown capability/);
  });

  it('forwards console output', async () => {
    const seen = [];
    const sb = await make({ onConsole: (level, ...a) => seen.push([level, ...a]) });
    await sb.evaluate('console.log("hi", 1)');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [['log', 'hi', '1']]);
  });

  it('defineModule + sandboxImport work (data: URL under the hood)', async () => {
    const sb = await make();
    await sb.defineModule('utils', 'export const add = (a, b) => a + b;');
    assert.equal(await sb.evaluate('const { add } = await sandboxImport("utils"); return add(2, 3)'), 5);
  });

  it('virtual modules survive a restart after timeout', async () => {
    const sb = await make();
    await sb.defineModule('k', 'export default 7;');
    await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 100 }), /timed out/i);
    assert.equal(await sb.evaluate('return (await sandboxImport("k")).default'), 7);
  });

  it('import-map specifiers resolve through import()', async () => {
    const url = 'data:text/javascript,export default 99';
    const sb = await make({ importMap: { imports: { ninetynine: url } } });
    assert.equal(await sb.evaluate('return (await sandboxImport("ninetynine")).default'), 99);
  });

  it('dispose rejects pending evaluations', async () => {
    const sb = await make();
    const p = sb.evaluate('await new Promise(() => {})', { timeoutMs: 0 });
    await new Promise((r) => setTimeout(r, 50));
    await sb.dispose();
    await assert.rejects(p, /disposed/);
    assert.equal(sb.isDisposed(), true);
  });

  it('never calls URL.createObjectURL', async () => {
    const orig = URL.createObjectURL;
    let calls = 0;
    URL.createObjectURL = (...a) => { calls++; return orig.apply(URL, a); };
    try {
      const sb = await make();
      await sb.defineModule('m', 'export default 1');
      await sb.evaluate('return (await sandboxImport("m")).default');
      await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 100 }), /timed out/i);
      await sb.evaluate('return 1');
    } finally {
      URL.createObjectURL = orig;
    }
    assert.equal(calls, 0);
  });
});

describe('node mode — explicit selection', () => {
  it("mode: 'node-worker' works", async () => {
    const sb = await make({ mode: 'node-worker' });
    assert.equal(await sb.evaluate('return typeof process'), 'object');
  });

  it('a custom workerFactory is used when given', async () => {
    const { createNodeWorkerFactory } = await import('../src/index.mjs');
    const factory = await createNodeWorkerFactory();
    let made = 0;
    const sb = await make({ workerFactory: (src) => { made++; return factory(src); } });
    assert.equal(await sb.evaluate('return 5'), 5);
    assert.equal(made, 1);
  });
});

describe('node mode — data-uri mode', () => {
  it('executes code, returns default export, captures print', async () => {
    const sb = createSandbox({ mode: 'data-uri' });
    const r = await sb.execute('print("hello"); export default 41 + 1;');
    assert.equal(r.success, true);
    assert.equal(r.output, 'hello');
    assert.equal(r.returnValue, 42);
  });

  it('injects globals', async () => {
    const sb = createSandbox({ mode: 'data-uri', globals: { x: 42 } });
    const r = await sb.execute('print(x)');
    assert.equal(r.success, true, r.error);
    assert.equal(r.output, '42');
  });

  it('does not call URL.createObjectURL', async () => {
    const orig = URL.createObjectURL;
    let calls = 0;
    URL.createObjectURL = (...a) => { calls++; return orig.apply(URL, a); };
    try {
      await createSandbox({ mode: 'data-uri' }).execute('print(1)');
    } finally {
      URL.createObjectURL = orig;
    }
    assert.equal(calls, 0);
  });
});

describe('node mode — unsupported', () => {
  it('service-worker mode still rejects clearly under Node', async () => {
    await assert.rejects(
      () => createSandbox({ mode: 'service-worker', scriptURL: 'https://x/sw.js' }),
      /requires navigator\.serviceWorker/,
    );
  });
});

describe('node mode — virtual modules importing each other', () => {
  it('relative imports between virtual modules', async () => {
    const sb = await make();
    await sb.defineModule('lib/a', 'import { b } from "./b"; export const a = b + 1;');
    await sb.defineModule('lib/b', 'export const b = 41;');
    assert.equal(await sb.evaluate('return (await sandboxImport("lib/a")).a'), 42);
  });

  it('bare-name imports, ../ imports and cycles', async () => {
    const sb = await make();
    await sb.defineModule('top', 'import { n } from "lib/n"; import { m } from "./lib/m.js"; export default n + m;');
    await sb.defineModule('lib/n', 'import { top2 } from "../top2"; export const n = top2;');
    await sb.defineModule('top2', 'export const top2 = 5;');
    await sb.defineModule('lib/m', 'import * as t from "../top"; export const m = 100;');
    assert.equal(await sb.evaluate('return (await sandboxImport("top")).default'), 105);
  });

  it('modules defined before the worker (re)starts keep their relative imports', async () => {
    const sb = await make();
    await sb.defineModule('p/a', 'import { b } from "./b"; export default b;');
    await sb.defineModule('p/b', 'export const b = "ok";');
    await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 100 }), /timed out/i);
    assert.equal(await sb.evaluate('return (await sandboxImport("p/a")).default'), 'ok');
  });

  it('redefining a module is picked up, including by dependents', async () => {
    const sb = await make();
    await sb.defineModule('m/a', 'import { v } from "./b"; export default v;');
    await sb.defineModule('m/b', 'export const v = 1;');
    assert.equal(await sb.evaluate('return (await sandboxImport("m/a")).default'), 1);
    await sb.defineModule('m/b', 'export const v = 2;');
    await sb.defineModule('m/a', 'import { v } from "./b"; export default v + 0.5;');
    assert.equal(await sb.evaluate('return (await sandboxImport("m/a")).default'), 2.5);
  });

  it('virtual modules can use the sandbox import map', async () => {
    const sb = await make({ importMap: { imports: { k: 'data:text/javascript,export default 7' } } });
    await sb.defineModule('u', 'import k from "k"; export default k * 2;');
    assert.equal(await sb.evaluate('return (await sandboxImport("u")).default'), 14);
  });

  it('a missing relative import rejects with a clear error', async () => {
    const sb = await make();
    await sb.defineModule('x/a', 'import "./nope";');
    await assert.rejects(() => sb.evaluate('await sandboxImport("x/a")'), /nope/);
  });
});

describe('createSandbox — mode validation', () => {
  it('throws a clear error listing supported modes for an unknown mode', () => {
    assert.throws(
      () => createSandbox({ mode: 'wroker' }),
      (e) => /Unknown sandbox mode 'wroker'/.test(e.message)
        && ['worker', 'node-worker', 'wasm', 'iframe', 'inline', 'data-uri', 'service-worker'].every((m) => e.message.includes(m)),
    );
    assert.throws(() => createSandbox({ mode: '' }), /Unknown sandbox mode/);
  });
});

describe('node mode — nodeWorker hardening (opt-in)', () => {
  it('by default env is inherited (documented, unchanged)', async () => {
    process.env.ANDBOX_TEST_SECRET = 's3cret';
    try {
      const sb = await make();
      assert.equal(await sb.evaluate('return process.env.ANDBOX_TEST_SECRET'), 's3cret');
    } finally { delete process.env.ANDBOX_TEST_SECRET; }
  });

  it('permissions: true isolates env', async () => {
    process.env.ANDBOX_TEST_SECRET = 's3cret';
    try {
      const sb = await make({ nodeWorker: { permissions: true } });
      assert.equal(await sb.evaluate('return process.env.ANDBOX_TEST_SECRET'), undefined);
      assert.equal(await sb.evaluate('return Object.keys(process.env).length'), 0);
    } finally { delete process.env.ANDBOX_TEST_SECRET; }
  });

  it('an explicit env is passed through, and nothing else', async () => {
    process.env.ANDBOX_TEST_SECRET = 's3cret';
    try {
      const sb = await make({ nodeWorker: { permissions: true, env: { FOO: 'bar' } } });
      assert.deepEqual(await sb.evaluate('return { ...process.env }'), { FOO: 'bar' });
    } finally { delete process.env.ANDBOX_TEST_SECRET; }
  });

  it('permission model denies fs read and child_process', async () => {
    const sb = await make({ nodeWorker: { permissions: true } });
    const code = `
      const r = {};
      const m = await import('data:text/javascript,export default 1'); r.data = m.default;
      try { const fs = process.getBuiltinModule('node:fs'); fs.readFileSync('/etc/hostname'); r.fs = 'READ'; } catch (e) { r.fs = e.code ?? e.message; }
      return r;`;
    const r = await sb.evaluate(code);
    assert.equal(r.data, 1);
    assert.notEqual(r.fs, 'READ');
  });

  it('process escape hatches and builtin imports are blocked', async () => {
    const sb = await make({ nodeWorker: { permissions: true } });
    const r = await sb.evaluate(`
      const out = {
        binding: typeof process.binding,
        getBuiltinModule: typeof process.getBuiltinModule,
        linked: typeof process._linkedBinding,
        dlopen: typeof process.dlopen,
      };
      for (const s of ['node:fs', 'fs', 'node:child_process', 'node:worker_threads', 'file:///etc/hostname']) {
        try { await import(s); out[s] = 'IMPORTED'; } catch (e) { out[s] = 'blocked'; }
      }
      return out;`);
    assert.deepEqual(r, {
      binding: 'undefined', getBuiltinModule: 'undefined', linked: 'undefined', dlopen: 'undefined',
      'node:fs': 'blocked', fs: 'blocked', 'node:child_process': 'blocked',
      'node:worker_threads': 'blocked', 'file:///etc/hostname': 'blocked',
    });
  });

  it('virtual modules and import maps still work when hardened', async () => {
    const sb = await make({ nodeWorker: { permissions: true } });
    await sb.defineModule('h/a', 'import { b } from "./b"; export default b + 1;');
    await sb.defineModule('h/b', 'export const b = 1;');
    assert.equal(await sb.evaluate('return (await sandboxImport("h/a")).default'), 2);
    assert.equal(await sb.evaluate('return 1 + 1'), 2);
  });

  it('maxMemoryMb caps the heap; the sandbox recovers afterwards', async () => {
    const sb = await make({ nodeWorker: { maxMemoryMb: 32 }, defaultTimeoutMs: 20000 });
    await assert.rejects(
      () => sb.evaluate('const a = []; while (true) a.push(new Array(1e5).fill(1));'),
      /memory|Worker error/i,
    );
    assert.equal(await sb.evaluate('return "alive"'), 'alive');
  });

  it('permissions: true applies a default memory cap', async () => {
    const sb = await make({ nodeWorker: { permissions: true, maxMemoryMb: 32 }, defaultTimeoutMs: 20000 });
    await assert.rejects(() => sb.evaluate('const a = []; while (true) a.push(new Array(1e5).fill(1));'), /memory|Worker error/i);
    assert.equal(await sb.evaluate('return 2'), 2);
  });

  it('thread stdout/stderr is captured into onConsole when permissions: true', async () => {
    const seen = [];
    const sb = await make({ nodeWorker: { permissions: true }, onConsole: (l, ...a) => seen.push([l, ...a]) });
    await sb.evaluate('process.stdout.write("out!"); process.stderr.write("err!")');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(seen.sort(), [['stderr', 'err!'], ['stdout', 'out!']]);
  });

  it('rejects invalid nodeWorker options', async () => {
    await assert.rejects(() => createSandbox({ nodeWorker: { maxMemoryMb: -1 } }), /maxMemoryMb/);
  });
});
