import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gateCapabilities } from '../src/capability-gate.mjs';

describe('gateCapabilities', () => {
  it('passes through calls when no limits set', async () => {
    const caps = { add: (a, b) => a + b };
    const { gated } = gateCapabilities(caps);
    assert.equal(await gated.add(2, 3), 5);
  });

  it('enforces global maxCalls', async () => {
    const caps = { fn: () => 'ok' };
    const { gated } = gateCapabilities(caps, { limits: { maxCalls: 2 } });
    assert.equal(await gated.fn(), 'ok');
    assert.equal(await gated.fn(), 'ok');
    await assert.rejects(() => gated.fn(), /Global call limit exceeded/);
  });

  it('enforces per-capability maxCalls', async () => {
    const caps = { a: () => 1, b: () => 2 };
    const { gated } = gateCapabilities(caps, {
      capabilities: { a: { maxCalls: 1 } },
    });
    assert.equal(await gated.a(), 1);
    await assert.rejects(() => gated.a(), /Capability 'a' call limit exceeded/);
    // b is unaffected
    assert.equal(await gated.b(), 2);
  });

  it('enforces per-capability maxArgBytes', async () => {
    const caps = { fn: (s) => s };
    const { gated } = gateCapabilities(caps, {
      capabilities: { fn: { maxArgBytes: 10 } },
    });
    await assert.rejects(
      () => gated.fn('this is a very long string that exceeds the limit'),
      /Capability 'fn' argument size exceeded/
    );
  });

  it('tracks stats', async () => {
    const caps = { fn: () => 'ok' };
    const { gated, stats } = gateCapabilities(caps);
    await gated.fn();
    await gated.fn();
    const s = stats();
    assert.equal(s.totalCalls, 2);
    assert.equal(s.perCapability.fn.calls, 2);
  });

  it('handles async capability functions', async () => {
    const caps = { slow: async () => { await new Promise(r => setTimeout(r, 10)); return 42; } };
    const { gated } = gateCapabilities(caps);
    assert.equal(await gated.slow(), 42);
  });

  it('enforces maxConcurrent', async () => {
    let active = 0;
    const caps = {
      fn: async () => {
        active++;
        await new Promise(r => setTimeout(r, 50));
        active--;
        return active;
      },
    };
    const { gated } = gateCapabilities(caps, { limits: { maxConcurrent: 1 } });
    const p1 = gated.fn();
    await assert.rejects(() => gated.fn(), /Concurrent call limit exceeded/);
    await p1;
  });
});
