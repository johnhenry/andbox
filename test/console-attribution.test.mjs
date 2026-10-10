/**
 * andbox#41: concurrent evaluate() calls get their own console output, every
 * console handler gets `this.consoleId`, and a failed evaluation keeps the
 * sandbox-side stack as `err.sandboxStack`.
 *
 * Runs under plain Node in both Worker-backed modes: the default (`worker`,
 * which picks worker_threads here) and an explicit `node-worker`. The browser
 * Worker and `mode: 'iframe'` run the same checks in
 * test/browser/console-attribution.spec.mjs.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';

const open = [];
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait (up to 5 s) until `check()` is true: output from a timer arrives when it arrives. */
async function until(check) {
  for (const t0 = Date.now(); !check(); await settle(5)) {
    if (Date.now() - t0 > 5000) return;
  }
}

for (const mode of [undefined, 'node-worker']) {
  const make = async (opts = {}) => {
    const sb = await createSandbox(mode ? { mode, ...opts } : opts);
    open.push(sb);
    return sb;
  };

  describe(`console attribution (${mode ?? 'default worker'} mode)`, () => {
    it('overlapping calls each get their own output (the issue repro)', async () => {
      const a = [];
      const b = [];
      const sb = await make();
      const first = sb.evaluate("await new Promise(r => setTimeout(r, 50)); console.log('a')", { onConsole: (l, ...x) => a.push([l, ...x]) });
      // 'a' is logged while the second call is still running.
      const second = sb.evaluate("console.log('b'); await new Promise(r => setTimeout(r, 100)); return 1", { onConsole: (l, ...x) => b.push([l, ...x]) });
      await Promise.all([first, second]);
      assert.deepEqual(a, [['log', 'a']]);
      assert.deepEqual(b, [['log', 'b']]);
    });

    it('interleaved output from two running calls stays with each call', async () => {
      const seen = { x: [], y: [] };
      const sb = await make();
      const code = (tag) => `for (let i = 0; i < 4; i++) { console.log('${tag}' + i); await new Promise(r => setTimeout(r, 5)); }`;
      await Promise.all([
        sb.evaluate(code('x'), { onConsole: (l, t) => seen.x.push(t) }),
        sb.evaluate(code('y'), { onConsole: (l, t) => seen.y.push(t) }),
      ]);
      assert.deepEqual(seen.x, ['x0', 'x1', 'x2', 'x3']);
      assert.deepEqual(seen.y, ['y0', 'y1', 'y2', 'y3']);
    });

    it('a finished call does not leave its handler in place for later calls', async () => {
      const sandbox = [];
      const a = [];
      const b = [];
      const sb = await make({ onConsole: (l, t) => sandbox.push(t) });
      // A starts, B starts, A settles, then B settles: no handler may outlive its call.
      const first = sb.evaluate("await new Promise(r => setTimeout(r, 20)); console.log('a')", { onConsole: (l, t) => a.push(t) });
      const second = sb.evaluate("await new Promise(r => setTimeout(r, 60)); console.log('b')", { onConsole: (l, t) => b.push(t) });
      await Promise.all([first, second]);
      await sb.evaluate("console.log('plain')");
      await settle(10);
      assert.deepEqual(a, ['a']);
      assert.deepEqual(b, ['b']);
      assert.deepEqual(sandbox, ['plain']);
    });

    it('handlers get this.consoleId, also for output after the call settled', async () => {
      const sandbox = [];
      const call = [];
      const sb = await make({ onConsole(l, t) { sandbox.push([this.consoleId, t]); } });
      await sb.evaluate("console.log('now'); setTimeout(() => console.log('later'), 20)", {
        consoleId: 'pane-1',
        onConsole(l, t) { call.push([this.consoleId, t]); },
      });
      await sb.evaluate("console.log('untagged')");
      await sb.evaluate("console.log('numbered')", { consoleId: 7 });
      await until(() => sandbox.length >= 3);
      assert.deepEqual(call, [['pane-1', 'now']]);
      // After the call settled its handler is gone: the sandbox-level one gets
      // the late line, still credited to 'pane-1'.
      // (The timer's line may arrive before or after the next two calls' lines.)
      const byText = (x, y) => x[1].localeCompare(y[1]);
      assert.deepEqual(sandbox.sort(byText), [['pane-1', 'later'], [7, 'numbered'], [undefined, 'untagged']]);
    });

    it('consoleId must be a string or a finite number', async () => {
      const sb = await make();
      await assert.rejects(() => sb.evaluate('return 1', { consoleId: { pane: 1 } }), TypeError);
      await assert.rejects(() => sb.evaluate('return 1', { consoleId: NaN }), TypeError);
      assert.equal(await sb.evaluate('return 1', { consoleId: '' }), 1);
    });

    it('a failed evaluation keeps the sandbox-side stack as err.sandboxStack', async () => {
      const sb = await make();
      const err = await sb.evaluate('const f = () => { throw new RangeError("deep"); };\nf();\n//# sourceURL=user-code.js').catch((e) => e);
      assert.equal(err.name, 'RangeError');
      assert.equal(err.message, 'deep');
      assert.equal(typeof err.sandboxStack, 'string');
      assert.match(err.sandboxStack, /deep/);
      assert.match(err.sandboxStack, /user-code\.js:\d+/);
    });
  });
}
