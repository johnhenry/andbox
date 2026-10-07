// Runs the wasm-mode checks inside a real browser Worker and reports them in
// the DOM (#result as JSON, #status, document.title) so a headless run can read them.
import { createSandbox } from '../../src/index.mjs';

const results = [];
const check = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (e) {
    results.push({ name, ok: false, detail: `${e?.name}: ${e?.message}` });
  }
};
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

const sb = await createSandbox({
  mode: 'wasm',
  engineURL: './public/andbox-quickjs.mjs',
  wasmURL: './public/andbox-quickjs.wasm',
  capabilities: { double: async (n) => n * 2, boom: async () => { throw new Error('nope'); } },
  memoryBytes: 16 * 1024 * 1024,
});

await check('worker is a real browser Worker', () => {
  expect(typeof Worker === 'function' && typeof window === 'object', 'not in a browser');
  return typeof WorkerGlobalScope;
});
await check('basic result + trailing // comment', async () => {
  expect((await sb.evaluate('return 1 + 2 // c')) === 3, 'bad result');
  const o = await sb.evaluate('return { a: [1, "x", null] }');
  expect(JSON.stringify(o) === '{"a":[1,"x",null]}', 'bad object');
});
await check('async host calls (single + concurrent) and errors', async () => {
  expect((await sb.evaluate('return await host.call("double", 21)')) === 42, 'double');
  const r = await sb.evaluate('return await Promise.all([host.call("double", 1), host.call("double", 2)])');
  expect(JSON.stringify(r) === '[2,4]', 'concurrent');
  const m = await sb.evaluate('try { await host.call("boom") } catch (e) { return e.message }');
  expect(m === 'nope', 'host error');
  try { await sb.evaluate('await host.call("nope")'); expect(false, 'should reject'); }
  catch (e) { expect(/Unknown capability/.test(e.message), 'unknown cap'); }
});
await check('no ambient fetch/WebSocket/importScripts/indexedDB/postMessage/self', async () => {
  const t = await sb.evaluate(`return ['fetch','WebSocket','importScripts','indexedDB','postMessage','self','XMLHttpRequest','Worker','navigator','location','caches'].map((k) => typeof globalThis[k]).join()`);
  expect(/^(undefined,){10}undefined$/.test(t), t);
});
await check('globalThis.constructor chain stays in the guest realm', async () => {
  const t = await sb.evaluate('return globalThis.constructor.constructor("return typeof fetch + typeof importScripts")()');
  expect(t === 'undefinedundefined', t);
});
await check("host.call('constructor', ...) is an unknown capability", async () => {
  try { await sb.evaluate('return await host.call("constructor", "return 1")'); expect(false, 'should reject'); }
  catch (e) { expect(/Unknown capability/.test(e.message), e.message); }
});
await check('sandboxImport of a URL is refused', async () => {
  try { await sb.evaluate('return await sandboxImport("https://example.com/x.js")'); expect(false, 'should reject'); }
  catch (e) { expect(/Cannot resolve module/.test(e.message), e.message); }
});
await check('virtual module round trip', async () => {
  await sb.defineModule('m', 'export const x = 5;');
  expect((await sb.evaluate('return (await sandboxImport("m")).x')) === 5, 'x');
});
await check('fuel exhaustion: distinct error code, deterministic count', async () => {
  const counts = [];
  for (let i = 0; i < 3; i++) {
    try { await sb.evaluate('while (true) {}', { fuel: 200 }); expect(false, 'should reject'); }
    catch (e) { expect(e.code === 'ERR_ANDBOX_FUEL_EXHAUSTED' && e.name === 'FuelExhaustedError', `${e.name} ${e.code}`); }
    counts.push(sb.stats().fuelUsed);
  }
  expect(counts.every((c) => c === counts[0]), `counts differ: ${counts}`);
  return counts;
});
await check('memory cap enforced', async () => {
  try { await sb.evaluate('return new ArrayBuffer(64 * 1024 * 1024).byteLength'); expect(false, 'should reject'); }
  catch (e) { expect(e.name === 'MemoryLimitError', `${e.name}: ${e.message}`); }
});
await check('deadline kills a busy loop and the worker survives', async () => {
  const t0 = performance.now();
  try { await sb.evaluate('while (true) {}', { deadlineMs: 150 }); expect(false, 'should reject'); }
  catch (e) { expect(e.name === 'TimeoutError' && e.code === 'ERR_ANDBOX_DEADLINE', `${e.name} ${e.code}`); }
  const ms = Math.round(performance.now() - t0);
  expect(ms < 400, `took ${ms}ms`);
  expect((await sb.evaluate('return "alive"')) === 'alive', 'not alive');
  return `${ms}ms`;
});
await check('stack cap: deep recursion is a catchable RangeError', async () => {
  const n = await sb.evaluate('function f(n){return f(n+1)+1} try { f(0) } catch (e) { return e.name }');
  expect(n === 'RangeError', n);
});

await sb.dispose();
const failed = results.filter((r) => !r.ok);
document.getElementById('result').textContent = JSON.stringify({ failed: failed.length, results }, null, 2);
document.getElementById('status').textContent = failed.length ? 'FAILED' : 'PASSED';
document.title = failed.length ? 'andbox-wasm FAILED' : 'andbox-wasm PASSED';
