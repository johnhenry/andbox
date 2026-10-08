/**
 * #30: a capability that returns after its Worker was killed must not crash
 * the host. #8: in-flight capabilities get an AbortSignal tied to the
 * Worker's lifetime and it is aborted on timeout / abort / dispose.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Surface the crash #30 describes: an unhandled rejection / uncaught exception
// anywhere in the process while a test runs fails that test.
function trapProcessErrors() {
  const errors = [];
  const onRej = (e) => errors.push(e);
  process.on('unhandledRejection', onRej);
  process.on('uncaughtException', onRej);
  return {
    errors,
    stop() {
      process.off('unhandledRejection', onRej);
      process.off('uncaughtException', onRej);
    },
  };
}

describe('#30 late capability results after the worker is gone', () => {
  it('a capability returning after a timeout is dropped silently', async () => {
    const trap = trapProcessErrors();
    try {
      const sb = await make({
        capabilities: { slow: async () => { await sleep(300); return 'done'; } },
      });
      await assert.rejects(
        () => sb.evaluate("return await host.call('slow')", { timeoutMs: 100 }),
        /timed out/i,
      );
      await sleep(500);
      assert.deepEqual(trap.errors, []);
      // sandbox still usable afterwards
      assert.equal(await sb.evaluate('return 1 + 1'), 2);
    } finally {
      trap.stop();
    }
  });

  it('a capability that throws after dispose is dropped silently', async () => {
    const trap = trapProcessErrors();
    try {
      const sb = await make({
        capabilities: { slow: async () => { await sleep(200); throw new Error('late failure'); } },
      });
      const p = sb.evaluate("return await host.call('slow')").catch(() => {});
      await sleep(50);
      await sb.dispose();
      await p;
      await sleep(400);
      assert.deepEqual(trap.errors, []);
    } finally {
      trap.stop();
    }
  });

  it('a late result from the old worker is not delivered to the replacement worker', async () => {
    const seen = [];
    const sb = await make({
      capabilities: { slow: async () => { await sleep(250); return 'old'; }, who: async () => 'new' },
    });
    await assert.rejects(() => sb.evaluate("return await host.call('slow')", { timeoutMs: 80 }), /timed out/i);
    // new worker running a long call while the old call completes
    const r = await sb.evaluate("await new Promise(r => setTimeout(r, 400)); return await host.call('who')", { timeoutMs: 3000 });
    assert.equal(r, 'new');
  });
});

describe('#8 capability calls get an AbortSignal tied to the sandbox lifetime', () => {
  it('this.signal is aborted when evaluate() times out', async () => {
    let signal;
    let abortedAt = null;
    const sb = await make({
      capabilities: {
        slowWrite: async function () {
          signal = this.signal;
          signal.addEventListener('abort', () => { abortedAt = Date.now(); });
          await new Promise((r) => setTimeout(r, 1000));
          return 'wrote';
        },
      },
    });
    await assert.rejects(
      () => sb.evaluate("return await host.call('slowWrite')", { timeoutMs: 150 }),
      /timed out/i,
    );
    assert.ok(signal instanceof AbortSignal, 'capability receives this.signal');
    assert.equal(signal.aborted, true);
    assert.ok(abortedAt !== null);
  });

  it('a cooperative capability is actually cancelled (side effect does not complete)', async () => {
    let effect = 'not started';
    const sb = await make({
      capabilities: {
        write: async function () {
          effect = 'started';
          await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, 400);
            this.signal.addEventListener('abort', () => { clearTimeout(t); reject(this.signal.reason); });
          });
          effect = 'completed';
        },
      },
    });
    await assert.rejects(() => sb.evaluate("return await host.call('write')", { timeoutMs: 100 }), /timed out/i);
    await sleep(600);
    assert.equal(effect, 'started');
  });

  it('is aborted by an evaluate() AbortSignal and by dispose()', async () => {
    const signals = [];
    const sb = await make({
      capabilities: { hang: async function () { signals.push(this.signal); await sleep(2000); } },
    });
    const ac = new AbortController();
    const p = sb.evaluate("return await host.call('hang')", { signal: ac.signal });
    await sleep(100);
    while (signals.length < 1) await sleep(20);
    ac.abort();
    await assert.rejects(() => p, (e) => e.name === 'AbortError');
    assert.equal(signals[0].aborted, true);

    const p2 = sb.evaluate("return await host.call('hang')").catch(() => {});
    while (signals.length < 2) await sleep(20);
    await sb.dispose();
    await p2;
    assert.equal(signals[1].aborted, true);
  });

  it('the signal of a healthy call is not aborted and the call completes', async () => {
    let s;
    const sb = await make({ capabilities: { ok: async function (x) { s = this.signal; return x * 2; } } });
    assert.equal(await sb.evaluate("return await host.call('ok', 21)"), 42);
    assert.equal(s.aborted, false);
  });

  it('arrow-function and plain capabilities keep working (signal is in `this`, not in args)', async () => {
    let received;
    const sb = await make({ capabilities: { echo: (...args) => { received = args; return args.length; }, max: Math.max } });
    assert.equal(await sb.evaluate("return await host.call('echo', 1, 2)"), 2);
    assert.deepEqual(received, [1, 2]);
    assert.equal(await sb.evaluate("return await host.call('max', 3, 9, 4)"), 9);
  });
});
