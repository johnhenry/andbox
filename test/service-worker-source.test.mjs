/**
 * makeServiceWorkerSource() tests.
 *
 * The generated script itself only runs in a real ServiceWorkerGlobalScope
 * (self.clients, self.skipWaiting, the fetch/install/activate events --
 * none of which exist in Node), so this is a real but necessarily-shallow
 * check, same as test/sandbox.test.mjs's worker-mode smoke test: confirm
 * it's a real string containing the lifecycle/message/fetch wiring the
 * doc comment promises, without trying to fake executing it as a Service
 * Worker.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeServiceWorkerSource } from '../src/service-worker-source.mjs';

describe('makeServiceWorkerSource', () => {
  const source = makeServiceWorkerSource();

  it('returns a non-empty string', () => {
    assert.equal(typeof source, 'string');
    assert.ok(source.length > 0);
  });

  it('is syntactically valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(source));
  });

  it('registers install, activate, message, and fetch listeners', () => {
    assert.match(source, /addEventListener\('install'/);
    assert.match(source, /addEventListener\('activate'/);
    assert.match(source, /addEventListener\('message'/);
    assert.match(source, /addEventListener\('fetch'/);
  });

  it('calls skipWaiting() on install and clients.claim() on activate', () => {
    assert.match(source, /self\.skipWaiting\(\)/);
    assert.match(source, /self\.clients\.claim\(\)/);
  });

  it('handles configure/define/remove messages', () => {
    assert.match(source, /'configure'/);
    assert.match(source, /'define'/);
    assert.match(source, /'remove'/);
  });

  it('never intercepts cross-origin requests', () => {
    assert.match(source, /url\.origin !== self\.location\.origin/);
  });
});
