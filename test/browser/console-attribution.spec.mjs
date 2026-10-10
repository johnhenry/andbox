// andbox#41 in real browsers, for a browser Worker (mode: 'worker') and a
// sandboxed iframe (mode: 'iframe'): overlapping evaluate() calls get their
// own console output, handlers get `this.consoleId` (also for output after
// the call settled), and a failed call keeps `err.sandboxStack`.
// test/console-attribution.test.mjs runs the same checks under Node.
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  page.on('pageerror', (e) => console.error(`[${test.info().project.name}] pageerror:`, e.message));
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ready === true);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    for (const sb of window.open_ ?? []) await sb.dispose();
  }).catch(() => {});
});

/** Run `fn` in the host page with `make(opts)` creating (and tracking) a sandbox in `mode`. */
function host(page, mode, fn) {
  return page.evaluate(
    async ([m, src]) => {
      window.open_ ??= [];
      const make = async (opts = {}) => {
        const sb = await window.andbox.createSandbox({ mode: m, ...opts });
        window.open_.push(sb);
        return sb;
      };
      const settle = (ms) => new Promise((r) => setTimeout(r, ms));
      return (0, eval)(`(${src})`)(make, settle);
    },
    [mode, fn.toString()],
  );
}

for (const mode of ['worker', 'iframe']) {
  test.describe(`console attribution (${mode})`, () => {
    test('overlapping calls each get their own output', async ({ page }) => {
      const r = await host(page, mode, async (make) => {
        const a = [];
        const b = [];
        const sb = await make();
        const first = sb.evaluate("await new Promise(r => setTimeout(r, 50)); console.log('a')", { onConsole: (l, ...x) => a.push([l, ...x]) });
        const second = sb.evaluate("console.log('b'); await new Promise(r => setTimeout(r, 150)); return 1", { onConsole: (l, ...x) => b.push([l, ...x]) });
        await Promise.all([first, second]);
        return { a, b };
      });
      expect(r.a).toEqual([['log', 'a']]);
      expect(r.b).toEqual([['log', 'b']]);
    });

    test('no handler outlives its call; this.consoleId names the call, also after it settled', async ({ page }) => {
      const r = await host(page, mode, async (make, settle) => {
        const sandbox = [];
        const a = [];
        const b = [];
        const sb = await make({ onConsole(l, t) { sandbox.push([this.consoleId, t]); } });
        const first = sb.evaluate("await new Promise(r => setTimeout(r, 20)); console.log('a'); setTimeout(() => console.log('a-late'), 100)", {
          consoleId: 'A',
          onConsole(l, t) { a.push([this.consoleId, t]); },
        });
        const second = sb.evaluate("await new Promise(r => setTimeout(r, 60)); console.log('b')", {
          consoleId: 'B',
          onConsole(l, t) { b.push([this.consoleId, t]); },
        });
        await Promise.all([first, second]);
        await sb.evaluate("console.log('plain')");
        for (const t0 = Date.now(); sandbox.length < 2 && Date.now() - t0 < 5000; ) await settle(10);
        return { sandbox, a, b };
      });
      expect(r.a).toEqual([['A', 'a']]);
      expect(r.b).toEqual([['B', 'b']]);
      expect(r.sandbox.sort((x, y) => x[1].localeCompare(y[1]))).toEqual([['A', 'a-late'], [undefined, 'plain']]);
    });

    test('a failed evaluation keeps the sandbox-side stack as err.sandboxStack', async ({ page }) => {
      const r = await host(page, mode, async (make) => {
        const sb = await make();
        const err = await sb.evaluate('const f = () => { throw new RangeError("deep"); };\nf();\n//# sourceURL=user-code.js').catch((e) => e);
        return { name: err.name, message: err.message, sandboxStack: err.sandboxStack };
      });
      expect(r.name).toBe('RangeError');
      expect(r.message).toBe('deep');
      expect(typeof r.sandboxStack).toBe('string');
      // Every engine names the throwing function's frame; Chromium and Firefox
      // also use the sourceURL (WebKit may not for code from new Function).
      expect(r.sandboxStack.length).toBeGreaterThan(0);
    });
  });
}
