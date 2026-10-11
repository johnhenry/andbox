// andbox#50: createSandbox({ mode: 'iframe', frameSrc }) in real browsers.
//
// A sandboxed frame can navigate itself (`location = ...`, a clicked link, a
// meta refresh) and nothing inside it can stop that. With `frameSrc` the
// frame is nested in a same-origin wrapper whose CSP is `frame-src <hosts>`,
// which the browser checks before the navigation request is sent. Two local
// stub servers stand in for "a listed host" and "any other host": the test
// asserts the unlisted one never receives a request.
import http from 'node:http';
import { test, expect } from '@playwright/test';

/** @type {{ listed: http.Server, other: http.Server }} */
const stubs = {};
/** Requests each stub received, by name. */
const hits = { listed: [], other: [] };
const origin = (name) => `http://127.0.0.1:${stubs[name].address().port}`;

test.beforeAll(async () => {
  for (const name of ['listed', 'other']) {
    stubs[name] = http.createServer((req, res) => {
      hits[name].push(req.url);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<!doctype html><p>stub</p>');
    });
    await new Promise((resolve) => stubs[name].listen(0, '127.0.0.1', resolve));
  }
});

test.afterAll(async () => {
  for (const s of Object.values(stubs)) await new Promise((resolve) => s.close(resolve));
});

test.beforeEach(async ({ page }) => {
  hits.listed.length = 0;
  hits.other.length = 0;
  page.on('pageerror', (e) => console.error(`[${test.info().project.name}] pageerror:`, e.message));
  await page.goto('/test/browser/fixture.html');
  await page.waitForFunction(() => window.ready === true);
});

test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    for (const sb of window.open_ ?? []) await sb.dispose();
  }).catch(() => {});
});

/** Run `fn(make, settle, arg)` in the host page; `make(opts)` creates a tracked iframe sandbox. */
function host(page, fn, arg) {
  return page.evaluate(
    async ([src, a]) => {
      window.open_ ??= [];
      const make = async (opts = {}) => {
        const sb = await window.andbox.createSandbox({ mode: 'iframe', ...opts });
        window.open_.push(sb);
        return sb;
      };
      const settle = async (p) => {
        try { return { ok: true, value: await p }; } catch (e) {
          return { ok: false, name: e?.name, message: e?.message };
        }
      };
      return (0, eval)(`(${src})`)(make, settle, a);
    },
    [fn.toString(), arg],
  );
}

/** Give a navigation that slipped through time to reach a stub. */
const quiet = (page) => page.waitForTimeout(700);

test.describe("mode: 'iframe' with frameSrc", () => {
  test('the frame is nested in a same-origin wrapper with a frame-src CSP; the code runs in an opaque origin', async ({ page }) => {
    const r = await host(page, async (make, settle, hosts) => {
      const sb = await make({ frameSrc: hosts, container: document.querySelector('#pane') });
      const wrapper = sb.iframe;
      const inner = wrapper.contentDocument.querySelector('iframe');
      return {
        keys: Object.keys(sb).sort(),
        wrapperSandbox: wrapper.getAttribute('sandbox'),
        wrapperParent: wrapper.parentNode.id,
        csp: wrapper.contentDocument.querySelector('meta[http-equiv="Content-Security-Policy"]').content,
        wrapperScripts: wrapper.contentDocument.scripts.length,
        innerSandbox: inner.getAttribute('sandbox'),
        frameWindowIsInner: sb.frameWindow === inner.contentWindow,
        origin: await sb.evaluate('return [location.origin, origin]'),
        hostDocument: await settle(sb.evaluate('return parent.parent.document.title')),
        wrapperDocument: await settle(sb.evaluate('return parent.document.title')),
      };
    }, [origin('listed')]);
    expect(r.keys).toEqual(['defineModule', 'dispose', 'evaluate', 'iframe', 'isDisposed', 'stats']);
    expect(r.wrapperSandbox).toBeNull();
    expect(r.wrapperParent).toBe('pane');
    expect(r.csp).toBe(`frame-src ${origin('listed')}`);
    expect(r.wrapperScripts).toBe(0);
    expect(r.innerSandbox).toBe('allow-scripts');
    expect(r.frameWindowIsInner).toBe(true);
    expect(r.origin[1]).toBe('null');
    expect(r.hostDocument.ok).toBe(false);
    expect(r.wrapperDocument.ok).toBe(false);
  });

  for (const [how, code] of [
    ['location', (url) => `location = ${JSON.stringify(url)}`],
    ['a clicked link', (url) => `const a = document.createElement('a'); a.href = ${JSON.stringify(url)}; document.body.append(a); a.click()`],
    ['a meta refresh', (url) => `const m = document.createElement('meta'); m.httpEquiv = 'refresh'; m.content = ${JSON.stringify(`0;url=${url}`)}; document.head.append(m)`],
  ]) {
    test(`navigating itself to a host not in the list (${how}) sends nothing, and the sandbox recovers`, async ({ page }) => {
      const r = await host(page, async (make, settle, [hosts, code]) => {
        const sb = await make({ frameSrc: hosts, defaultTimeoutMs: 3000 });
        const nav = await settle(sb.evaluate(`${code}; await new Promise(() => {})`));
        return { nav, after: await sb.evaluate('return 1 + 1') };
      }, [[origin('listed')], code(`${origin('other')}/?leak=${how}`)]);
      await quiet(page);
      expect(hits.other).toEqual([]);
      expect(r.nav.ok).toBe(false);
      expect(r.after).toBe(2);
    });

    test(`control: without frameSrc the same navigation (${how}) does reach the host`, async ({ page }) => {
      await host(page, async (make, settle, code) => {
        const sb = await make({ defaultTimeoutMs: 3000 });
        await settle(sb.evaluate(`${code}; await new Promise(() => {})`));
      }, code(`${origin('other')}/?control`));
      await expect.poll(() => hits.other).toEqual(['/?control']);
    });
  }

  test('an empty list allows no navigation at all; the sandbox still starts', async ({ page }) => {
    const r = await host(page, async (make, settle, url) => {
      const sb = await make({ frameSrc: [], defaultTimeoutMs: 3000 });
      const csp = sb.iframe.contentDocument.querySelector('meta[http-equiv="Content-Security-Policy"]').content;
      const nav = await settle(sb.evaluate(`location = ${JSON.stringify(url)}; await new Promise(() => {})`));
      return { csp, nav, after: await sb.evaluate('return "ok"') };
    }, `${origin('listed')}/?none`);
    await quiet(page);
    expect(r.csp).toBe("frame-src 'none'");
    expect(hits.listed).toEqual([]);
    expect(r.nav.ok).toBe(false);
    expect(r.after).toBe('ok');
  });

  test('navigating to a listed host goes through', async ({ page }) => {
    const r = await host(page, async (make, settle, [hosts, url]) => {
      const sb = await make({ frameSrc: hosts, defaultTimeoutMs: 3000 });
      const nav = await settle(sb.evaluate(`location = ${JSON.stringify(url)}; await new Promise(() => {})`));
      return { nav, after: await sb.evaluate('return 3') };
    }, [[origin('listed')], `${origin('listed')}/?allowed`]);
    expect(hits.listed).toEqual(['/?allowed']);
    expect(r.nav.ok).toBe(false);
    expect(r.nav.message).toMatch(/unloaded/);
    expect(r.after).toBe(3);
  });

  test('evaluate, host.call, consoles (per call, consoleId) and bridges work through the wrapper', async ({ page }) => {
    const r = await host(page, async (make, settle, hosts) => {
      const sandboxLog = [];
      const callLog = [];
      const ids = [];
      const destroyed = [];
      const sb = await make({
        frameSrc: hosts,
        capabilities: { add: (a, b) => a + b },
        onConsole(level, ...args) { sandboxLog.push([level, ...args]); ids.push(this.consoleId); },
        bridges: {
          svc: {
            api: {
              open: { handle: true, call: (ctx, name) => ctx.handle('Thing', { name }) },
              count: { stream: true, call: (ctx, n) => (async function* () { for (let i = 1; i <= n; i++) yield i; })() },
            },
            handles: { Thing: { methods: { hello: (ctx) => `hi ${ctx.target.name}` }, props: ['name'], destroy: (t) => destroyed.push(t.name) } },
          },
        },
      });
      const sum = await sb.evaluate('return await host.call("add", 2, 3)');
      const first = sb.evaluate("await new Promise(r => setTimeout(r, 50)); console.log('a')", {
        consoleId: 'one',
        onConsole(level, ...args) { callLog.push([this.consoleId, level, ...args]); },
      });
      const second = sb.evaluate("console.log('b'); await new Promise(r => setTimeout(r, 120))", {
        consoleId: 'two',
        onConsole(level, ...args) { callLog.push([this.consoleId, level, ...args]); },
      });
      await Promise.all([first, second]);
      await sb.evaluate('console.warn("sandbox-level")', { consoleId: 7 });
      const bridged = await sb.evaluate(`
        const t = await svc.open('x');
        const nums = [];
        for await (const n of svc.count(3)) nums.push(n);
        const out = [await t.hello(), t.name, nums];
        await t.destroy();
        return out;
      `);
      const failed = await settle(sb.evaluate('throw new Error("boom")'));
      return { sum, callLog, sandboxLog, ids, bridged, destroyed, failed };
    }, [origin('listed')]);
    expect(r.sum).toBe(5);
    expect(r.callLog).toEqual([['two', 'log', 'b'], ['one', 'log', 'a']]);
    expect(r.sandboxLog).toEqual([['warn', 'sandbox-level']]);
    expect(r.ids).toEqual([7]);
    expect(r.bridged).toEqual(['hi x', 'x', [1, 2, 3]]);
    expect(r.destroyed).toEqual(['x']);
    expect(r.failed).toMatchObject({ ok: false, message: 'boom' });
  });

  test('a restart builds a new wrapper in the same place with the same attributes; allow is delegated to the inner frame', async ({ page }) => {
    const r = await host(page, async (make, settle, hosts) => {
      const pane = document.querySelector('#pane');
      const seen = [];
      const sb = await make({
        frameSrc: hosts,
        container: pane,
        defaultTimeoutMs: 600,
        onFrame: (f) => { seen.push(f); f.className = 'pane-frame'; f.setAttribute('allow', 'autoplay'); },
      });
      const before = sb.iframe;
      await sb.evaluate('globalThis.kept = 1');
      const timedOut = await settle(sb.evaluate('await new Promise(() => {})'));
      const after = await sb.evaluate('return typeof globalThis.kept');
      const inner = sb.iframe.contentDocument.querySelector('iframe');
      return {
        timedOut: timedOut.name,
        after,
        replaced: before !== sb.iframe && !before.isConnected,
        frames: seen.length,
        cls: sb.iframe.className,
        inPane: sb.iframe.parentNode === pane && pane.children.length === 1,
        innerAllow: inner.getAttribute('allow'),
        frameWindow: sb.frameWindow === inner.contentWindow,
      };
    }, [origin('listed')]);
    expect(r.timedOut).toBe('TimeoutError');
    expect(r.after).toBe('undefined');
    expect(r.replaced).toBe(true);
    expect(r.frames).toBe(2);
    expect(r.cls).toBe('pane-frame');
    expect(r.inPane).toBe(true);
    expect(r.innerAllow).toBe('autoplay');
    expect(r.frameWindow).toBe(true);
  });

  test('dispose() removes the wrapper and clears frameWindow', async ({ page }) => {
    const r = await host(page, async (make, settle, hosts) => {
      const sb = await make({ frameSrc: hosts });
      const el = sb.iframe;
      await sb.dispose();
      return { gone: !el.isConnected, iframe: sb.iframe, frameWindow: sb.frameWindow };
    }, [origin('listed')]);
    expect(r).toEqual({ gone: true, iframe: null, frameWindow: null });
  });

  test('without frameSrc nothing changes: no wrapper, and frameWindow is the frame\'s own window', async ({ page }) => {
    const r = await host(page, async (make) => {
      const sb = await make();
      return {
        sandbox: sb.iframe.getAttribute('sandbox'),
        frameWindow: sb.frameWindow === sb.iframe.contentWindow,
        parentIsHost: await sb.evaluate('return parent === parent.parent'),
      };
    });
    expect(r).toEqual({ sandbox: 'allow-scripts', frameWindow: true, parentIsHost: true });
  });
});
