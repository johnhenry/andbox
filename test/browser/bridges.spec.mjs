// #46: createSandbox({ bridges }) in real browsers (Chromium, Firefox, WebKit),
// for a browser Worker (mode: 'worker') and a sandboxed iframe (mode: 'iframe').
//
// CI has no on-device model, so the Chrome AI bridge runs against a fake of
// the platform APIs (test/fixtures/fake-chrome-ai.mjs) installed on the page.
// The last test is a smoke test against the browser's real LanguageModel; it
// is skipped where the API or the model is unavailable.
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

/** Run `fn(make, lib, arg)` in the page; `make(opts)` creates a tracked sandbox in `mode`. */
function host(page, mode, fn, arg) {
  return page.evaluate(
    async ([m, src, a]) => {
      window.open_ ??= [];
      const make = async (opts = {}) => {
        const sb = await window.andbox.createSandbox({ mode: m, ...opts });
        window.open_.push(sb);
        return sb;
      };
      const lib = {
        ...(await import('/src/bridges/chrome-ai.mjs')),
        ...(await import('/test/fixtures/fake-chrome-ai.mjs')),
        until: async (cond, ms = 3000) => {
          const end = Date.now() + ms;
          while (!cond()) {
            if (Date.now() > end) throw new Error('timed out waiting for condition');
            await new Promise((r) => setTimeout(r, 10));
          }
        },
      };
      return (0, eval)(`(${src})`)(make, lib, a);
    },
    [mode, fn.toString(), arg],
  );
}

for (const mode of ['worker', 'iframe']) {
  test.describe(`bridges, mode: '${mode}'`, () => {
    test('handles, streams, abort, callbacks; dispose destroys every handle', async ({ page }) => {
      const r = await host(page, mode, async (make, lib) => {
        const destroyed = [];
        let cancelled = 0;
        let seq = 0;
        const sb = await make({
          bridges: {
            svc: {
              api: {
                open: { handle: true, async call(ctx, opts = {}) { await opts.onReady?.('ready'); return ctx.handle('Thing', { id: ++seq }); } },
                count: {
                  stream: true,
                  call: (ctx, n) => new ReadableStream({
                    i: 0,
                    pull(c) { this.i = (this.i ?? 0) + 1; if (this.i > n) c.close(); else c.enqueue(this.i); },
                    cancel() { cancelled++; },
                  }),
                },
                wait: (ctx) => new Promise((_, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason))),
              },
              handles: { Thing: { methods: { get: (ctx) => ctx.target.id }, props: ['id'], destroy: (t) => destroyed.push(t.id) } },
            },
          },
        });
        const value = await sb.evaluate(`
          const ready = [];
          const a = await svc.open({ onReady: (x) => { ready.push(x); } });
          globalThis.b = await svc.open();
          const nums = [];
          for await (const n of svc.count(3)) nums.push(n);
          const reader = svc.count(1000).getReader();
          await reader.read();
          await reader.cancel();
          const c = new AbortController();
          setTimeout(() => c.abort(), 10);
          let aborted;
          try { await svc.wait({ signal: c.signal }); } catch (e) { aborted = e.name; }
          a.destroy();
          return { ready, id: a.id, get: await b.get(), nums, aborted };
        `);
        await lib.until(() => destroyed.length === 1 && cancelled === 1);
        const before = [...destroyed];
        await sb.dispose();
        return { value, before, after: destroyed };
      });
      expect(r.value).toEqual({ ready: ['ready'], id: 1, get: 2, nums: [1, 2, 3], aborted: 'AbortError' });
      expect(r.before).toEqual([1]);
      expect(r.after).toEqual([1, 2]);
    });

    test('Chrome AI bridge against a fake LanguageModel on the page: session, streaming, monitor, consent', async ({ page }) => {
      const r = await host(page, mode, async (make, lib) => {
        const fake = lib.createFakeChromeAI();
        // Installed like the real thing, on the page's global (the default scope).
        Object.assign(window, fake.scope);
        const methods = [];
        const sb = await make({
          bridges: { ai: lib.chromeAI({ globals: true, onRequest: (q) => { methods.push(q.method); return true; } }) },
        });
        const value = await sb.evaluate(`
          const native = typeof globalThis.LanguageModel === 'function'; // the bridge's object, not a platform constructor
          const availability = await LanguageModel.availability();
          const progress = [];
          const session = await LanguageModel.create({ monitor(m) { m.addEventListener('downloadprogress', (e) => progress.push(e.loaded)); } });
          const answer = await session.prompt('hi');
          let streamed = '';
          for await (const chunk of session.promptStreaming('a b c')) streamed += chunk;
          return { native, availability, progress, answer, streamed, usage: session.contextUsage };
        `);
        await sb.dispose();
        return { value, methods, destroyed: fake.log.destroyed };
      });
      expect(r.value).toEqual({ native: false, availability: 'available', progress: [0, 0.5, 1], answer: 'echo: hi', streamed: 'a b c', usage: 4 });
      expect(r.methods).toEqual(['languageModel.availability', 'languageModel.create', 'LanguageModel.prompt', 'LanguageModel.promptStreaming']);
      expect(r.destroyed).toEqual([1]);
    });

    test('a model download waits for a click in the app: onRequest resolves from the click handler', async ({ page }) => {
      const pending = host(page, mode, async (make, lib) => {
        const fake = lib.createFakeChromeAI({ availability: 'downloadable' });
        const sb = await make({
          bridges: {
            ai: lib.chromeAI({
              scope: fake.scope,
              // The app's consent UI: a button whose click handler approves.
              onRequest: (q) => new Promise((resolve) => {
                if (!q.requiresUserActivation) { resolve(true); return; }
                const button = document.createElement('button');
                button.id = 'consent';
                button.textContent = 'Download the model';
                button.onclick = () => { button.remove(); resolve(true); };
                document.body.append(button);
              }),
            }),
          },
        });
        return sb.evaluate(`return (await ai.languageModel.create()).prompt('after download')`);
      });
      await page.click('#consent');
      expect(await pending).toBe('echo: after download');
    });

    test('without activation, a download-needing create() is refused before reaching the platform', async ({ page }) => {
      // page.evaluate() runs with a user gesture, so this page runs on its own.
      const message = page.waitForEvent('console', (m) => m.text().startsWith('andbox-activation-result '));
      await page.goto(`/test/browser/bridges-activation.html?mode=${mode}`);
      const r = JSON.parse((await message).text().slice('andbox-activation-result '.length));
      // Every engine here implements navigator.userActivation; without it the check is the platform's.
      expect(r.hasAPI).toBe(true);
      expect(r.value[0]).toBe('NotAllowedError');
      expect(r.value[1]).toMatch(/requires sticky user activation/);
      expect(r.requests).toEqual([['sticky', { isActive: false, hasBeenActive: false }]]);
      expect(r.created).toBe(0);
    });
  });
}

test('the sandbox has no Chrome AI of its own: Workers and opaque-origin frames get nothing', async ({ page }) => {
  const r = await host(page, 'worker', async (make) => {
    const out = {};
    for (const mode of ['worker', 'iframe']) {
      const sb = await window.andbox.createSandbox({ mode });
      window.open_.push(sb);
      out[mode] = await sb.evaluate(`
        const C = globalThis.LanguageModel;
        if (typeof C !== 'function') return 'absent';
        let availability;
        try { availability = await C.availability(); } catch (e) { availability = e.name; }
        try { (await C.create()).destroy(); return availability + '/created'; } catch (e) { return availability + '/' + e.name; }
      `);
    }
    out.page = typeof window.LanguageModel === 'function' ? await window.LanguageModel.availability() : 'absent';
    return out;
  });
  console.log(`[${test.info().project.name}] Chrome AI: page=${r.page} worker=${r.worker} iframe=${r.iframe}`);
  expect(r.worker).toBe('absent');
  // Chromium exposes LanguageModel in the frame, but the permissions policy
  // (default 'self') does not match an opaque origin: unavailable, NotAllowedError.
  expect(['absent', 'unavailable/NotAllowedError']).toContain(r.iframe);
});

test('smoke: the real LanguageModel through the bridge (skipped without the API)', async ({ page }) => {
  const availability = await page.evaluate(async () =>
    (typeof window.LanguageModel === 'function' ? window.LanguageModel.availability() : 'absent'));
  test.skip(availability === 'absent', 'this browser has no LanguageModel');
  const r = await host(page, 'worker', async (make, lib, ready) => {
    const sb = await make({ bridges: { ai: lib.chromeAI({ apis: ['languageModel'] }) }, defaultTimeoutMs: 120_000 });
    // Only prompt when the model is already on disk: never start a download in a test run.
    return sb.evaluate(ready ? `
      const availability = await ai.languageModel.availability();
      const session = await ai.languageModel.create();
      const answer = await session.prompt('Reply with the single word: pong');
      const usage = session.contextUsage ?? session.inputUsage;
      session.destroy();
      return { availability, type: typeof answer, usage: typeof usage };
    ` : `return { availability: await ai.languageModel.availability() };`);
  }, availability === 'available');
  console.log(`[${test.info().project.name}] real LanguageModel through the bridge: ${JSON.stringify(r)}`);
  expect(r.availability).toBe(availability);
  if (availability === 'available') expect(r).toEqual({ availability, type: 'string', usage: 'number' });
});
