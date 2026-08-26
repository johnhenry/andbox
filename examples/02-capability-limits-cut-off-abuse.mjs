/**
 * 02 — Capability limits cut off abuse.
 *
 * Demonstrates: gateCapabilities() wraps the host functions you expose to
 * a sandbox and enforces rate limits — global call caps, per-capability
 * call caps, per-call argument byte caps, and concurrency caps — so
 * untrusted code can't hammer or flood your capabilities. This is the
 * same gate createSandbox() applies to its `capabilities` option via
 * `policy`.
 *
 * Runs under plain Node (pure logic, no Worker needed).
 */

import assert from 'node:assert/strict';
import { gateCapabilities } from '../src/index.mjs';

const capabilities = {
  readConfig: (key) => `value-of-${key}`,
  log: (msg) => msg,
  slowJob: async () => new Promise((r) => setTimeout(() => r('done'), 50)),
};

const { gated, stats } = gateCapabilities(capabilities, {
  limits: { maxCalls: 5, maxConcurrent: 1 },       // global caps
  capabilities: {
    readConfig: { maxCalls: 2 },                    // per-capability call cap
    log: { maxArgBytes: 16 },                       // per-call payload cap
  },
});

// 1. Normal use passes through.
assert.equal(await gated.readConfig('theme'), 'value-of-theme');
assert.equal(await gated.log('short msg'), 'short msg');
console.log('normal calls pass through the gate');

// 2. Per-capability call limit: 3rd readConfig call is refused.
await gated.readConfig('lang');
await assert.rejects(() => gated.readConfig('again'), /Capability 'readConfig' call limit exceeded/);
console.log('3rd readConfig call refused (per-capability maxCalls: 2)');

// 3. Oversized payloads are refused before reaching the host function.
await assert.rejects(
  () => gated.log('x'.repeat(1000)),
  /Capability 'log' argument size exceeded/
);
console.log('oversized log payload refused (maxArgBytes: 16)');

// 4. Concurrency cap: a second in-flight call is refused.
const inFlight = gated.slowJob();
await assert.rejects(() => gated.slowJob(), /Concurrent call limit exceeded/);
assert.equal(await inFlight, 'done');
console.log('parallel slowJob refused while one was in flight (maxConcurrent: 1)');

// 5. Global cap: refused calls don't count — 4 calls have succeeded so far.
//    A 5th succeeds, then the 6th trips the global maxCalls of 5.
assert.equal(await gated.log('5th call'), '5th call');
const s = stats();
assert.equal(s.totalCalls, 5);
await assert.rejects(() => gated.log('hi'), /Global call limit exceeded/);
console.log('6th successful call refused (global maxCalls: 5)');
console.log('gate stats:', JSON.stringify(s.perCapability));
console.log('OK: abusive call patterns were cut off, legitimate ones served');
