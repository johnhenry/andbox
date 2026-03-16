/**
 * Sandbox tests — these require a browser environment (Worker + Blob URL).
 * Run with a browser test runner (e.g., Playwright) or skip in Node.
 *
 * For Node-only CI, the import-map-resolver and capability-gate tests
 * provide coverage of the pure logic.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Sandbox tests are browser-only (need Worker). Verify the module loads.
describe('sandbox module', () => {
  it('exports createSandbox', async () => {
    // Dynamic import to avoid Worker errors in Node
    const mod = await import('../src/sandbox.mjs');
    assert.equal(typeof mod.createSandbox, 'function');
  });
});

describe('index re-exports', () => {
  it('exports all public API', async () => {
    const mod = await import('../src/index.mjs');
    assert.equal(typeof mod.createSandbox, 'function');
    assert.equal(typeof mod.resolveWithImportMap, 'function');
    assert.equal(typeof mod.gateCapabilities, 'function');
    assert.equal(typeof mod.createStdio, 'function');
    assert.equal(typeof mod.createNetworkFetch, 'function');
    assert.equal(typeof mod.makeDeferred, 'function');
    assert.equal(typeof mod.makeAbortError, 'function');
    assert.equal(typeof mod.makeTimeoutError, 'function');
    assert.equal(typeof mod.makeWorkerSource, 'function');
    assert.equal(typeof mod.DEFAULT_TIMEOUT_MS, 'number');
    assert.ok(mod.DEFAULT_LIMITS);
    assert.ok(mod.DEFAULT_CAPABILITY_LIMITS);
  });
});
