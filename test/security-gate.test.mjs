/**
 * Security regressions for #5 (capability gate bypass via the prototype
 * chain) and #9 (forgeable correlation ids). Real sandbox, real worker thread.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, createNodeWorkerFactory } from '../src/index.mjs';
import { gateCapabilities } from '../src/capability-gate.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

// Every name that resolves on a plain object, plus the legacy accessors.
const PROTOTYPE_NAMES = [...new Set([
  ...Object.getOwnPropertyNames(Object.prototype),
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__', '__proto__',
  // Function.prototype / Array.prototype names a lookup might also hit
  'call', 'apply', 'bind', 'length', 'name', 'prototype', 'then', 'toJSON',
])];

describe('#5 capability gate: lookup is own-property only', () => {
  it('lookup() resolves granted names and nothing else', () => {
    const { lookup } = gateCapabilities({ greet: () => 'hi' });
    assert.equal(typeof lookup('greet'), 'function');
    for (const name of PROTOTYPE_NAMES) {
      assert.equal(lookup(name), undefined, `lookup('${name}') must be undefined`);
    }
    for (const bad of [undefined, null, 1, {}, ['greet'], Symbol.iterator]) {
      assert.equal(lookup(bad), undefined, `lookup(${String(typeof bad)}) must be undefined`);
    }
  });

  it('a host-granted capability named like an Object.prototype member still works and is gated', async () => {
    const { lookup, stats } = gateCapabilities(
      { toString: () => 'granted', constructor: () => 'also granted' },
      { limits: { maxCalls: 1 } },
    );
    assert.equal(await lookup('toString')(), 'granted');
    await assert.rejects(() => lookup('constructor')(), /Global call limit exceeded/);
    assert.equal(stats().totalCalls, 1);
  });

  it('policy.capabilities lookups do not inherit from Object.prototype', async () => {
    // capPolicies['constructor'] would be the Object function; its enumerable
    // own props must not leak into the limits for a capability of that name.
    const { lookup } = gateCapabilities({ constructor: () => 1 }, { capabilities: {} });
    assert.equal(await lookup('constructor')(), 1);
  });

  it('end to end: host.call is denied for every Object.prototype name, never invoked, never counted', async () => {
    let invoked = 0;
    const sb = await make({
      capabilities: { greet: () => { invoked++; return 'hi'; } },
      policy: { limits: { maxCalls: 1 } },
    });
    for (const name of PROTOTYPE_NAMES) {
      await assert.rejects(
        () => sb.evaluate(`return await host.call(${JSON.stringify(name)}, 'anything')`),
        /Unknown capability/,
        `host.call('${name}') must be rejected`,
      );
    }
    assert.equal(invoked, 0);
    assert.equal(sb.stats().gate.totalCalls, 0, 'denied names must not be counted or consume the budget');
    // the one real call is still available afterwards
    assert.equal(await sb.evaluate(`return await host.call('greet')`), 'hi');
    await assert.rejects(() => sb.evaluate(`return await host.call('greet')`), /Global call limit exceeded/);
  });

  it('forged non-string capability names are rejected, not coerced to a granted name', async () => {
    const sb = await make({ capabilities: { greet: () => 'hi' } });
    await assert.rejects(
      () => sb.evaluate(`return await host.call(['greet'])`),
      /Unknown capability/,
    );
  });
});

describe('#9 correlation ids are unguessable and checked', () => {
  async function recordingFactory() {
    const make = await createNodeWorkerFactory();
    const sent = [];
    const factory = (source) => {
      const w = make(source);
      const orig = w.postMessage.bind(w);
      w.postMessage = (m) => { sent.push(m); return orig(m); };
      return w;
    };
    return { factory, sent };
  }

  it('evaluate ids and nonces are random, not sequential', async () => {
    const { factory, sent } = await recordingFactory();
    const sb = await make({ workerFactory: factory });
    await sb.evaluate('return 1');
    await sb.evaluate('return 2');
    const evals = sent.filter((m) => m.type === 'evaluate');
    assert.equal(evals.length, 2);
    for (const e of evals) {
      assert.match(String(e.id), /^[0-9a-f-]{36}$/);
      assert.equal(typeof e.nonce, 'string');
      assert.ok(e.nonce.length >= 32);
    }
    assert.notEqual(evals[0].id, evals[1].id);
    assert.notEqual(evals[0].nonce, evals[1].nonce);
    assert.notEqual(evals[0].id, evals[0].nonce);
  });

  it('a result carrying the right id but a wrong nonce is ignored', async () => {
    // A scripted worker: replies to `configure`, then to `evaluate` first with
    // a forged result (right id, wrong nonce) and afterwards the genuine one.
    const factory = () => {
      const w = {
        onmessage: null, onerror: null, dead: false,
        listeners: new Set(), terminate() {},
        addEventListener(_t, fn) { w.listeners.add(fn); },
        removeEventListener(_t, fn) { w.listeners.delete(fn); },
        emit(data) { w.onmessage?.({ data }); for (const fn of [...w.listeners]) fn({ data }); },
        postMessage(m) {
          queueMicrotask(() => {
            if (m.type === 'configure') w.emit({ type: 'configured' });
            if (m.type === 'evaluate') {
              w.emit({ type: 'result', id: m.id, nonce: 'guess', success: true, value: 'forged' });
              w.emit({ type: 'result', id: m.id, nonce: m.nonce, success: true, value: 'real' });
            }
          });
        },
      };
      return w;
    };
    const sb = await make({ workerFactory: factory });
    assert.equal(await sb.evaluate('return 1'), 'real');
  });

  it('capability rpc ids are random uuids', async () => {
    const mk = await createNodeWorkerFactory();
    const seen = [];
    const factory = (source) => {
      const w = mk(source);
      let handler = null;
      Object.defineProperty(w, 'onmessage', {
        get: () => handler,
        set: (fn) => {
          handler = (ev) => {
            if (ev.data?.type === 'capabilityCall') seen.push(ev.data.id);
            return fn(ev);
          };
        },
      });
      return w;
    };
    const sb = await make({ workerFactory: factory, capabilities: { a: () => 1 } });
    await sb.evaluate(`await host.call('a'); await host.call('a')`);
    assert.equal(seen.length, 2);
    for (const id of seen) assert.match(String(id), /^[0-9a-f-]{36}$/);
    assert.notEqual(seen[0], seen[1]);
  });
});
