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
