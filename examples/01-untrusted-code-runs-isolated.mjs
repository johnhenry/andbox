/**
 * 01 — Untrusted code runs isolated.
 *
 * Demonstrates: createSandbox() executes untrusted JavaScript in a scope
 * that only sees the globals you explicitly hand it, captures its printed
 * output, returns its result — and contains its crashes instead of
 * crashing the host.
 *
 * Runtime note: this example uses `mode: 'inline'` so it runs under plain
 * Node. The default `mode: 'worker'` gives stronger (thread-level)
 * isolation but requires a browser Web Worker — see examples/README.md.
 */

import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';

const hostSecret = 'do-not-leak';

const sandbox = createSandbox({
  mode: 'inline',
  // The ONLY values the untrusted code can see.
  globals: { input: [1, 2, 3, 4] },
});

// 1. Untrusted code computes with the injected globals and returns a result.
const ok = await sandbox.execute(`
  print('summing', input);
  return input.reduce((a, b) => a + b, 0);
`);
assert.equal(ok.success, true);
assert.equal(ok.returnValue, 10);
assert.equal(ok.output, 'summing [1,2,3,4]');
console.log('result from sandbox:', ok.returnValue);
console.log('captured output    :', ok.output);

// 2. Host variables are NOT visible inside the sandbox.
const probe = await sandbox.execute(`return typeof hostSecret;`);
assert.equal(probe.returnValue, 'undefined');
console.log('sandbox sees hostSecret as:', probe.returnValue, `(host still has ${hostSecret !== undefined ? 'it' : '??'})`);

// 3. A crash inside the sandbox is reported, not thrown at the host.
const boom = await sandbox.execute(`throw new Error('untrusted code exploded');`);
assert.equal(boom.success, false);
assert.match(boom.error, /untrusted code exploded/);
console.log('sandbox crash contained:', boom.error);

sandbox.terminate();
console.log('OK: untrusted code ran isolated, host unaffected');
