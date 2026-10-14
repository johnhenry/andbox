/**
 * #55: crypto.randomUUID exists only in secure contexts; a Blob Worker made
 * by an opaque-origin frame is not one, so capability host.call() threw
 * "crypto.randomUUID is not a function". Ids must be minted without it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomId } from '../src/random-id.mjs';

const PRELOAD = fileURLToPath(new URL('./fixtures/no-random-uuid.cjs', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('randomId without crypto.randomUUID', () => {
  it('returns unique v4-shaped ids from getRandomValues', () => {
    const real = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(globalThis.crypto), 'randomUUID');
    Object.defineProperty(Object.getPrototypeOf(globalThis.crypto), 'randomUUID', { value: undefined, configurable: true });
    try {
      assert.equal(typeof globalThis.crypto.randomUUID, 'undefined');
      const ids = new Set(Array.from({ length: 200 }, () => randomId()));
      assert.equal(ids.size, 200);
      for (const id of ids) assert.match(id, UUID);
    } finally {
      Object.defineProperty(Object.getPrototypeOf(globalThis.crypto), 'randomUUID', real);
    }
  });
});

describe('sandbox in an environment without crypto.randomUUID (host and worker)', () => {
  it('host.call() works', () => {
    const script = fileURLToPath(new URL('./fixtures/host-call-no-random-uuid.mjs', import.meta.url));
    const out = execFileSync(process.execPath, ['--require', PRELOAD, script], { encoding: 'utf8' });
    assert.equal(out.trim(), '[5,"undefined"]');
  });
});
