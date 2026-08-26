/**
 * 04 — Runaway code gets timed out.
 *
 * Demonstrates: sandboxed code that never finishes is cut off by the
 * execution timeout — the host gets a clean "Execution timed out" failure
 * instead of hanging forever, and the host keeps running afterwards.
 *
 * Runtime note (honest caveat): this uses `mode: 'inline'`, whose timeout
 * races the untrusted promise against a timer — it stops the host from
 * *waiting*, and handles code that hangs while awaiting. The default
 * `mode: 'worker'` goes further: on timeout it hard-kills the Worker
 * thread (worker.terminate()) and restarts it, which is the only reliable
 * way to stop a busy-spinning infinite loop. That hard-kill path needs a
 * browser Web Worker — see examples/README.md.
 */

import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';

const sandbox = createSandbox({ mode: 'inline', defaultTimeoutMs: 30000 });

// 1. Code that hangs forever (awaits a promise that never settles).
console.log('running code that never finishes, with a 200ms timeout...');
const started = Date.now();
const hung = await sandbox.execute(
  `await new Promise(() => {}); return 'unreachable';`,
  { timeout: 200 }
);
const elapsed = Date.now() - started;

assert.equal(hung.success, false);
assert.match(hung.error, /Execution timed out/);
assert.ok(elapsed < 5000, `should have been cut off quickly, took ${elapsed}ms`);
console.log(`cut off after ~${elapsed}ms with:`, hung.error);

// 2. The host — and the same sandbox — is still fully usable afterwards.
const after = await sandbox.execute(`return 'still alive';`, { timeout: 200 });
assert.equal(after.success, true);
assert.equal(after.returnValue, 'still alive');
console.log('sandbox after timeout:', after.returnValue);

sandbox.terminate();
console.log('OK: runaway code timed out cleanly, host survived');
