/**
 * 07 — `mode: 'wasm'` contains hostile code.
 *
 * Demonstrates: with `mode: 'wasm'` the code runs in QuickJS compiled to
 * WebAssembly inside the worker thread. It has no `fetch`, no `process`, no
 * way to reach the Worker's globals, and `host.call` is its only authority.
 * Runaway code is stopped by deterministic fuel, a memory cap and a deadline,
 * each with its own error code, and the sandbox keeps working afterwards.
 *
 * Needs the optional engine packages (devDependencies in this repo):
 *   npm install --save-exact quickjs-emscripten-core@0.32.0 @jitl/quickjs-ng-wasmfile-release-sync@0.32.0
 */

import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';

const sandbox = await createSandbox({
  mode: 'wasm',
  capabilities: { readConfig: async (key) => ({ greeting: 'hello' })[key] },
  memoryBytes: 16 * 1024 * 1024,
});

// 1. The one authority: host.call.
assert.equal(await sandbox.evaluate('return await host.call("readConfig", "greeting")'), 'hello');

// 2. Hostile code cannot reach the network, the process or the Worker.
const probe = await sandbox.evaluate(`
  return ['fetch', 'process', 'importScripts', 'postMessage', 'self']
    .map((k) => k + ':' + typeof globalThis[k]).join(' ');
`);
assert.equal(probe, 'fetch:undefined process:undefined importScripts:undefined postMessage:undefined self:undefined');
assert.equal(
  await sandbox.evaluate('return globalThis.constructor.constructor("return typeof fetch")()'),
  'undefined',
);
console.log('hostile probe saw:', probe);

// 3. Fuel is deterministic: the same runaway loop stops after the same count, every time.
const counts = [];
for (let i = 0; i < 3; i++) {
  await assert.rejects(
    () => sandbox.evaluate('while (true) {}', { fuel: 250 }),
    (e) => e.code === 'ERR_ANDBOX_FUEL_EXHAUSTED',
  );
  counts.push(sandbox.stats().fuelUsed);
}
assert.equal(new Set(counts).size, 1);
console.log('fuel used on 3 runaway loops:', counts.join(', '));

// 4. Memory and deadline have their own codes; the worker survives both.
await assert.rejects(
  () => sandbox.evaluate('return new ArrayBuffer(64 * 1024 * 1024).byteLength'),
  (e) => e.code === 'ERR_ANDBOX_MEMORY_LIMIT',
);
await assert.rejects(
  () => sandbox.evaluate('while (true) {}', { deadlineMs: 100 }),
  (e) => e.code === 'ERR_ANDBOX_DEADLINE',
);
assert.equal(await sandbox.evaluate('return "still alive"'), 'still alive');

await sandbox.dispose();
console.log('OK: hostile code contained, limits enforced, sandbox still usable');
