/**
 * #10 (partial): the worker prelude removes the ambient network/worker APIs
 * before user code runs. This is hardening, not a boundary: see README
 * "Security model" for what stays reachable. Runs on node:worker_threads.
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

const REMOVED = ['fetch', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'XMLHttpRequest',
  'Worker', 'SharedWorker', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel'];

describe('#10 worker prelude removes ambient network/worker globals', () => {
  it('none of them resolve by name, via globalThis, via indirect eval or via Function', async () => {
    const sb = await make();
    for (const name of REMOVED) {
      const r = await sb.evaluate(`return [
        typeof ${name},
        typeof globalThis.${name},
        (0, eval)('typeof ${name}'),
        new Function('return typeof ${name}')(),
      ]`);
      assert.deepEqual(r, ['undefined', 'undefined', 'undefined', 'undefined'], name);
    }
  });

  it('self / postMessage are not reachable by name, so code cannot forge protocol messages', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return typeof self + typeof postMessage'), 'undefinedundefined');
    assert.equal(await sb.evaluate('return new Function("return typeof postMessage + typeof self")()'), 'undefinedundefined');
  });

  it('`this` at the top level of evaluated code is not the global object', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return this === (0, eval)("this")'), false);
  });

  it('the sandbox still works: rpc, console, modules, errors, timeouts', async () => {
    const seen = [];
    const sb = await make({ capabilities: { add: (a, b) => a + b }, onConsole: (l, ...a) => seen.push([l, ...a]) });
    assert.equal(await sb.evaluate("return await host.call('add', 2, 3)"), 5);
    await sb.defineModule('m', 'export default 7');
    assert.equal(await sb.evaluate("return (await sandboxImport('m')).default"), 7);
    await sb.evaluate("console.log('hi')");
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(seen, [['log', 'hi']]);
    await assert.rejects(() => sb.evaluate('throw new RangeError("x")'), (e) => e.name === 'RangeError');
    await assert.rejects(() => sb.evaluate('while(true){}', { timeoutMs: 100 }), /timed out/i);
    assert.equal(await sb.evaluate('return 1'), 1); // fresh worker after the kill is hardened too
    assert.equal(await sb.evaluate('return typeof fetch'), 'undefined');
  });

  it('dispose() still closes the worker', async () => {
    const sb = await make();
    await sb.evaluate('return 1');
    await sb.dispose();
    assert.equal(sb.isDisposed(), true);
  });
});

describe('#10 what remains reachable is documented as such', () => {
  it('dynamic import() of a remote URL is still reachable (cannot be removed without a different isolation primitive)', async () => {
    const sb = await make();
    // The platform import() operator is syntax, not a global: it cannot be
    // deleted or shadowed. Here it reaches the loader (which, under Node,
    // refuses https) rather than being blocked by andbox.
    await assert.rejects(
      () => sb.evaluate(`return await import('https://example.invalid/x.js')`),
      (e) => !/Import denied/.test(e.message),
    );
  });
});
