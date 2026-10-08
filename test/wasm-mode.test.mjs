/**
 * mode: 'wasm' (andbox#21): user code runs in QuickJS-ng compiled to
 * WebAssembly inside the worker thread. These run under plain Node with the
 * optional engine packages installed (they are devDependencies here).
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, createNodeWorkerFactory } from '../src/index.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox({ mode: 'wasm', ...opts });
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

const MiB = 1024 * 1024;

describe('wasm mode: evaluate() contract (same shape as worker mode)', () => {
  it('returns values, objects and undefined', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return 1 + 2'), 3);
    assert.deepEqual(await sb.evaluate('return { a: [1, 2], b: "x", n: null }'), { a: [1, 2], b: 'x', n: null });
    assert.equal(await sb.evaluate('const x = 1;'), undefined);
    assert.equal(await sb.evaluate('return () => 1'), '[Function]');
    assert.equal(await sb.evaluate('return 10n'), '10');
  });

  it('supports top-level await', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return await Promise.resolve(41).then((n) => n + 1)'), 42);
  });

  it('handles code that ends in a // comment (andbox#23)', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return 1 // trailing'), 1);
    assert.equal(await sb.evaluate('const x = 2\nreturn x // done'), 2);
  });

  it('propagates thrown errors with name and message', async () => {
    const sb = await make();
    await assert.rejects(
      () => sb.evaluate('throw new TypeError("boom")'),
      (e) => e.name === 'TypeError' && /boom/.test(e.message),
    );
  });

  it('reports syntax errors as SyntaxError', async () => {
    const sb = await make();
    await assert.rejects(() => sb.evaluate('return ('), (e) => e.name === 'SyntaxError');
  });

  it('keeps no state between evaluate() calls (fresh context each time)', async () => {
    const sb = await make();
    await sb.evaluate('globalThis.leak = 42');
    assert.equal(await sb.evaluate('return typeof globalThis.leak'), 'undefined');
  });

  it('forwards console output, per call and per sandbox', async () => {
    const seen = [];
    const sb = await make({ onConsole: (level, ...a) => seen.push([level, ...a]) });
    await sb.evaluate('console.log("hi", 1, {a: 2}); console.warn("w")');
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(seen, [['log', 'hi', '1', '{"a":2}'], ['warn', 'w']]);
    const per = [];
    await sb.evaluate('console.error("e")', { onConsole: (level, ...a) => per.push([level, ...a]) });
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(per, [['error', 'e']]);
  });
});

describe('wasm mode: host.call is the only authority', () => {
  it('round-trips async host calls, including concurrent ones', async () => {
    const sb = await make({
      capabilities: {
        double: async (n) => n * 2,
        echo: async (v) => v,
        sleepy: (ms) => new Promise((r) => setTimeout(() => r(ms), ms)),
      },
    });
    assert.equal(await sb.evaluate('return await host.call("double", 21)'), 42);
    assert.deepEqual(await sb.evaluate('return await host.call("echo", { a: [1, "2", null] })'), { a: [1, '2', null] });
    assert.equal(await sb.evaluate('return await host.call("echo")'), undefined);
    assert.deepEqual(
      await sb.evaluate('return await Promise.all([host.call("sleepy", 40), host.call("sleepy", 10), host.call("double", 1)])'),
      [40, 10, 2],
    );
  });

  it('rejects unknown capabilities and surfaces host errors as guest errors', async () => {
    const sb = await make({ capabilities: { boom: async () => { throw new Error('nope') } } });
    await assert.rejects(() => sb.evaluate('return await host.call("missing")'), /Unknown capability: missing/);
    assert.equal(
      await sb.evaluate('try { await host.call("boom") } catch (e) { return e.message }'),
      'nope',
    );
  });

  it('applies the capability gate and rate limits unchanged', async () => {
    const sb = await make({
      capabilities: { once: async () => 'ok' },
      policy: { capabilities: { once: { maxCalls: 1 } } },
    });
    assert.equal(await sb.evaluate('return await host.call("once")'), 'ok');
    await assert.rejects(() => sb.evaluate('return await host.call("once")'), /call limit exceeded/);
    assert.equal(sb.stats().gate.totalCalls, 1);
  });

  it('cannot reach prototype-chain names through host.call', async () => {
    const sb = await make({ capabilities: { real: async () => 1 } });
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      await assert.rejects(
        () => sb.evaluate(`return await host.call(${JSON.stringify(name)}, 'return typeof fetch')`),
        /Unknown capability/,
        name,
      );
    }
  });

  it('host is frozen and its guest-realm constructors are not the Worker realm', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return Object.isFrozen(host)'), true);
    assert.equal(
      await sb.evaluate('return host.call.constructor("return typeof fetch + typeof self + typeof postMessage")()'),
      'undefinedundefinedundefined',
    );
  });
});

describe('wasm mode: escape attempts fail', () => {
  const AMBIENT = [
    'fetch', 'WebSocket', 'importScripts', 'indexedDB', 'postMessage', 'self', 'XMLHttpRequest',
    'Worker', 'EventSource', 'BroadcastChannel', 'navigator', 'location', 'caches', 'crypto',
    'require', 'process', 'Buffer', 'module', 'setTimeout', 'setInterval', 'WebAssembly',
  ];

  it('no ambient network / worker / node globals exist', async () => {
    const sb = await make();
    const types = await sb.evaluate(`return Object.fromEntries(${JSON.stringify(AMBIENT)}.map((k) => [k, typeof globalThis[k]]))`);
    for (const k of AMBIENT) assert.equal(types[k], 'undefined', k);
  });

  it('globalThis.constructor chains only reach the guest realm', async () => {
    const sb = await make();
    assert.equal(
      await sb.evaluate('return globalThis.constructor.constructor("return typeof fetch + typeof importScripts + typeof self")()'),
      'undefinedundefinedundefined',
    );
    assert.equal(
      await sb.evaluate('return (function () { return this })().constructor.constructor("return typeof fetch")()'),
      'undefined',
    );
    assert.equal(await sb.evaluate('return (0, eval)("typeof fetch")'), 'undefined');
    assert.equal(await sb.evaluate('return new Function("return typeof importScripts")()'), 'undefined');
  });

  it('own property names of the global contain nothing from the Worker realm', async () => {
    const sb = await make();
    const names = await sb.evaluate('return Object.getOwnPropertyNames(globalThis)');
    for (const bad of ['fetch', 'onmessage', 'postMessage', 'close', 'importScripts', 'name', 'indexedDB']) {
      assert.ok(!names.includes(bad), bad);
    }
  });

  it('sandboxImport and import() refuse URLs and Node builtins', async () => {
    const sb = await make();
    for (const spec of ['https://evil.example/x.js', 'http://localhost:1/x.js', 'data:text/javascript,export default 1', 'node:fs', 'fs', 'file:///etc/passwd']) {
      await assert.rejects(
        () => sb.evaluate(`return await sandboxImport(${JSON.stringify(spec)})`),
        /Cannot resolve module/,
        spec,
      );
      await assert.rejects(
        () => sb.evaluate(`return await import(${JSON.stringify(spec)})`),
        /Cannot resolve module/,
        spec,
      );
    }
  });

  it('an import map entry pointing at a URL does not make it loadable', async () => {
    const sb = await make({ importMap: { imports: { remote: 'https://evil.example/x.js' } } });
    await assert.rejects(() => sb.evaluate('return await sandboxImport("remote")'), /Cannot resolve module/);
  });

  it('cannot forge worker-protocol messages (no postMessage / self in the guest)', async () => {
    const sb = await make();
    await assert.rejects(
      () => sb.evaluate('postMessage({ type: "result", id: "x", success: true, value: 1 })'),
      (e) => e.name === 'ReferenceError',
    );
    await assert.rejects(
      () => sb.evaluate('self.postMessage({ type: "capabilityCall", name: "x", args: [] })'),
      (e) => e.name === 'ReferenceError',
    );
  });

  it('guest tampering with built-ins does not affect the next evaluation', async () => {
    const sb = await make({ capabilities: { one: async () => 1 } });
    await sb.evaluate('Object.prototype.polluted = 1; JSON.parse = () => "owned"; JSON.stringify = () => "x"; Array.prototype.map = null');
    assert.deepEqual(await sb.evaluate('return [typeof ({}).polluted, await host.call("one")]'), ['undefined', 1]);
  });

  it('guest tampering in the same evaluation cannot break the bridge result', async () => {
    const sb = await make({ capabilities: { one: async () => 1 } });
    // The bridge captured JSON.* before user code ran.
    assert.equal(await sb.evaluate('JSON.parse = () => "owned"; JSON.stringify = () => "x"; return await host.call("one")'), 1);
  });
});

describe('wasm mode: real limits', () => {
  it('fuel exhaustion is a distinct, deterministic error and the worker survives', async () => {
    let made = 0;
    const factory = await createNodeWorkerFactory();
    const sb = await make({ workerFactory: (src) => { made++; return factory(src); } });
    const counts = [];
    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => sb.evaluate('let i = 0; while (true) { i++ }', { fuel: 300 }),
        (e) => e.name === 'FuelExhaustedError' && e.code === 'ERR_ANDBOX_FUEL_EXHAUSTED',
      );
      counts.push(sb.stats().fuelUsed);
    }
    assert.deepEqual(counts, [301, 301, 301], 'identical fuel count across runs');
    assert.equal(made, 1, 'no worker respawn');
    assert.equal(await sb.evaluate('return "alive"'), 'alive');
  });

  it('fuelUsed for terminating code is identical across runs and below the cap', async () => {
    const sb = await make({ fuel: 100_000 });
    const used = [];
    for (let i = 0; i < 3; i++) {
      await sb.evaluate('let s = 0; for (let i = 0; i < 200000; i++) s += i; return s');
      used.push(sb.stats().fuelUsed);
    }
    assert.ok(used[0] > 0 && used[0] < 100_000);
    assert.deepEqual(used, [used[0], used[0], used[0]]);
  });

  it('guest code cannot catch fuel exhaustion', async () => {
    const sb = await make();
    await assert.rejects(
      () => sb.evaluate('try { while (true) {} } catch (e) { return "swallowed" }', { fuel: 50 }),
      (e) => e.name === 'FuelExhaustedError',
    );
  });

  it('memory cap: an allocation over memoryBytes throws MemoryLimitError', async () => {
    const sb = await make({ memoryBytes: 16 * MiB });
    await assert.rejects(
      () => sb.evaluate('return new ArrayBuffer(64 * 1024 * 1024).byteLength'),
      (e) => e.name === 'MemoryLimitError' && e.code === 'ERR_ANDBOX_MEMORY_LIMIT',
    );
    assert.equal(await sb.evaluate('return new ArrayBuffer(1024 * 1024).byteLength'), MiB);
    assert.ok(sb.stats().peakMemoryBytes > 0);
  });

  it('memory cap: incremental growth is cut off and the worker stays usable', async () => {
    const sb = await make({ memoryBytes: 8 * MiB });
    await assert.rejects(
      () => sb.evaluate('const a = []; for (;;) a.push(new Array(10000).fill(1))'),
      (e) => e.name === 'MemoryLimitError',
    );
    assert.equal(await sb.evaluate('return 7'), 7);
  });

  it('per-call limits override the sandbox defaults', async () => {
    const sb = await make({ memoryBytes: 64 * MiB });
    await assert.rejects(
      () => sb.evaluate('return new ArrayBuffer(8 * 1024 * 1024).byteLength', { memoryBytes: 2 * MiB }),
      (e) => e.name === 'MemoryLimitError',
    );
  });

  it('stack cap: deep recursion is a catchable RangeError, not a crash', async () => {
    const sb = await make({ stackBytes: 128 * 1024 });
    assert.equal(
      await sb.evaluate('function f(n) { return f(n + 1) + 1 } try { f(0) } catch (e) { return e.name }'),
      'RangeError',
    );
    await assert.rejects(() => sb.evaluate('function f(n) { return f(n + 1) + 1 } f(0)'), (e) => e.name === 'RangeError');
    assert.equal(await sb.evaluate('return "ok"'), 'ok');
  });

  it('deadline kills a busy loop within deadlineMs + 100 and the worker survives', async () => {
    let made = 0;
    const factory = await createNodeWorkerFactory();
    const sb = await make({ workerFactory: (src) => { made++; return factory(src); } });
    const t0 = performance.now();
    await assert.rejects(
      () => sb.evaluate('while (true) {}', { deadlineMs: 150 }),
      (e) => e.name === 'TimeoutError' && e.code === 'ERR_ANDBOX_DEADLINE' && /timed out/.test(e.message),
    );
    assert.ok(performance.now() - t0 < 150 + 300, `took ${performance.now() - t0}ms`);
    assert.equal(made, 1, 'no worker respawn');
    assert.equal(await sb.evaluate('return "alive"'), 'alive');
  });

  it('timeoutMs is honoured as the deadline when deadlineMs is not set', async () => {
    const sb = await make();
    const t0 = performance.now();
    await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 120 }), /timed out/i);
    assert.ok(performance.now() - t0 < 120 + 300);
    assert.equal(await sb.evaluate('return 1'), 1);
  });

  it('deadline also covers time spent waiting on a host call', async () => {
    const sb = await make({ capabilities: { never: () => new Promise(() => {}) } });
    const t0 = performance.now();
    await assert.rejects(
      () => sb.evaluate('await host.call("never")', { deadlineMs: 100 }),
      (e) => e.name === 'TimeoutError' && e.code === 'ERR_ANDBOX_DEADLINE',
    );
    assert.ok(performance.now() - t0 < 100 + 300);
    assert.equal(await sb.evaluate('return 2'), 2);
  });

  it('a late host result after a deadline is ignored', async () => {
    const sb = await make({ capabilities: { slow: () => new Promise((r) => setTimeout(() => r('late'), 120)) } });
    await assert.rejects(() => sb.evaluate('await host.call("slow")', { deadlineMs: 30 }), /timed out/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await sb.evaluate('return "fine"'), 'fine');
  });

  it('the host-side hard kill is still the backstop (AbortSignal restarts the worker)', async () => {
    const sb = await make();
    const ac = new AbortController();
    const p = sb.evaluate('while (true) {}', { signal: ac.signal, timeoutMs: 0, deadlineMs: 0 });
    setTimeout(() => ac.abort(), 50);
    await assert.rejects(p, (e) => e.name === 'AbortError');
    assert.equal(await sb.evaluate('return "back"'), 'back');
  });

  it('validates limit options', async () => {
    await assert.rejects(() => createSandbox({ mode: 'wasm', fuel: -1 }), /fuel must be/);
    await assert.rejects(() => createSandbox({ mode: 'wasm', memoryBytes: 'big' }), /memoryBytes must be/);
    const sb = await make();
    await assert.rejects(() => sb.evaluate('return 1', { deadlineMs: NaN }), /deadlineMs must be/);
  });
});

describe('wasm mode: virtual modules', () => {
  it('defineModule + sandboxImport, with relative imports and import-map names', async () => {
    const sb = await make({ importMap: { imports: { 'pkg/': 'lib/' } } });
    await sb.defineModule('lib/b.js', 'export const b = 2;');
    await sb.defineModule('lib/a.js', 'import { b } from "./b.js"; export const a = b + 1; export default "A";');
    await sb.defineModule('utils', 'export const add = (x, y) => x + y;');
    assert.equal(await sb.evaluate('const { add } = await sandboxImport("utils"); return add(2, 3)'), 5);
    assert.deepEqual(await sb.evaluate('const m = await sandboxImport("lib/a.js"); return [m.a, m.default]'), [3, 'A']);
    assert.equal(await sb.evaluate('return (await sandboxImport("pkg/b.js")).b'), 2);
    assert.equal(await sb.evaluate('return (await import("lib/b")).b'), 2);
  });

  it('virtual modules survive a worker restart', async () => {
    const sb = await make();
    await sb.defineModule('k', 'export default 7;');
    const ac = new AbortController();
    const p = sb.evaluate('while (true) {}', { signal: ac.signal, timeoutMs: 0, deadlineMs: 0 });
    setTimeout(() => ac.abort(), 30);
    await assert.rejects(p);
    assert.equal(await sb.evaluate('return (await sandboxImport("k")).default'), 7);
  });

  it('modules cannot see host.call', async () => {
    const sb = await make({ capabilities: { x: async () => 1 } });
    await sb.defineModule('m', 'export const t = typeof host;');
    assert.equal(await sb.evaluate('return (await sandboxImport("m")).t'), 'undefined');
  });
});

describe('wasm mode: engine loading and options', () => {
  it('stats() adds fuelUsed / peakMemoryBytes (and worker mode does not)', async () => {
    const sb = await make();
    await sb.evaluate('return 1');
    const s = sb.stats();
    assert.equal(typeof s.fuelUsed, 'number');
    assert.equal(typeof s.peakMemoryBytes, 'number');
    const plain = await createSandbox();
    open.push(plain);
    assert.equal('fuelUsed' in plain.stats(), false);
  });

  it('a bad engineURL fails createSandbox with a clear error', async () => {
    await assert.rejects(
      () => createSandbox({ mode: 'wasm', engineURL: 'file:///nonexistent/engine.mjs', wasmURL: 'file:///nonexistent/x.wasm' }),
      (e) => /Failed to load the WASM engine/.test(e.message) && e.code === 'ERR_ANDBOX_ENGINE',
    );
  });

  it('engineURL/wasmURL can come from import map entries', async () => {
    const { resolveNodeWasmEngine } = await import('../src/node-wasm.mjs');
    const { engineURL, wasmURL } = resolveNodeWasmEngine();
    const sb = await make({
      importMap: { imports: { '@johnhenry/andbox/wasm-engine': engineURL, '@johnhenry/andbox/wasm': wasmURL } },
    });
    assert.equal(await sb.evaluate('return 3'), 3);
  });

  it('refuses nodeWorker.permissions (engine must be read from disk)', async () => {
    await assert.rejects(() => createSandbox({ mode: 'wasm', nodeWorker: { permissions: true } }), /not supported with mode: 'wasm'/);
  });

  it('the unknown-mode error lists wasm', () => {
    assert.throws(() => createSandbox({ mode: 'nope' }), /'wasm'/);
  });
});

describe('wasm mode: parity with worker mode', () => {
  const PROGRAMS = [
    'return 1 + 2',
    'return { a: [1, 2, { b: null }], s: "x" }',
    'return await host.call("double", 21)',
    'return await Promise.all([host.call("double", 1), host.call("double", 2)])',
    'const x = 5\nreturn x * 2 // trailing comment',
    'return "str"',
    'return null',
    'return undefined',
    'return [1, "a", true, null]',
    'throw new RangeError("r")',
    'await host.call("missing")',
    'return await host.call("fail")',
    'return (await sandboxImport("m")).v',
  ];

  async function run(sb, code) {
    try { return { ok: await sb.evaluate(code) }; }
    catch (e) { return { err: [e.name, e.message] }; }
  }

  it('gives the same results for the same programs', async () => {
    const opts = { capabilities: { double: async (n) => n * 2, fail: async () => { throw new Error('bad') } } };
    const wasm = await make(opts);
    const plain = await createSandbox(opts);
    open.push(plain);
    for (const sb of [wasm, plain]) await sb.defineModule('m', 'export const v = 9;');
    for (const code of PROGRAMS) {
      assert.deepEqual(await run(wasm, code), await run(plain, code), code);
    }
  });
});

describe("createSandbox({ untrusted: true })", () => {
  it("selects mode: 'wasm' (no ambient fetch, virtual modules only)", async () => {
    const sb = await createSandbox({ untrusted: true });
    open.push(sb);
    assert.equal(await sb.evaluate('return typeof fetch + typeof process'), 'undefinedundefined');
    assert.equal(await sb.evaluate('return 1 + 1'), 2);
  });

  it("accepts an explicit mode: 'wasm' and untrusted: false is a no-op", async () => {
    const a = await createSandbox({ untrusted: true, mode: 'wasm' });
    open.push(a);
    const b = await createSandbox({ untrusted: false });
    open.push(b);
    assert.equal(await b.evaluate('return typeof process'), 'object');
  });

  it('throws when combined with a weaker mode', () => {
    for (const mode of ['worker', 'node-worker', 'inline', 'data-uri', 'service-worker']) {
      assert.throws(() => createSandbox({ untrusted: true, mode }), /untrusted.*wasm/);
    }
  });

  it('rejects when wasm mode is unavailable, never falling back', async () => {
    await assert.rejects(
      () => createSandbox({ untrusted: true, engineURL: 'file:///nonexistent/engine.mjs', wasmURL: 'file:///nonexistent/q.wasm' }),
      /untrusted: true.*wasm|wasm/i,
    );
  });
});
