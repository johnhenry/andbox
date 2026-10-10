// mode: 'iframe' in real browsers (Chromium, Firefox, WebKit).
//
// Every test drives andbox from the host page (test/browser/fixture.html,
// served from 127.0.0.1) through page.evaluate(); the sandbox runs in a
// sandboxed srcdoc <iframe> with an opaque origin. "Remote" modules are served
// from localhost on the same port, which is a different origin.
import { test, expect } from '@playwright/test';

const PORT = Number(process.env.ANDBOX_TEST_PORT) || 47391; // keep in sync with playwright.config.mjs
const REMOTE = `http://localhost:${PORT}/test/browser/fixtures/remote-module.mjs`;

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

/** Run `fn` in the host page with `make(opts)` creating (and tracking) a sandbox. */
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
          return { ok: false, name: e?.name, message: e?.message, isDOMException: e instanceof DOMException };
        }
      };
      return (0, eval)(`(${src})`)(make, settle, a);
    },
    [fn.toString(), arg],
  );
}

test.describe("mode: 'iframe'", () => {
  test('evaluate returns the value of `return`, wrapped in an async IIFE', async ({ page }) => {
    const r = await host(page, async (make) => {
      const sb = await make();
      return {
        sum: await sb.evaluate('return 1 + 2'),
        awaited: await sb.evaluate('const v = await Promise.resolve(41); return v + 1'),
        nothing: await sb.evaluate('const x = 1;'),
        trailingComment: await sb.evaluate('return "ok" // done'),
        shape: Object.keys(sb).sort(),
        disposed: sb.isDisposed(),
      };
    });
    expect(r.sum).toBe(3);
    expect(r.awaited).toBe(42);
    expect(r.nothing).toBeUndefined();
    expect(r.trailingComment).toBe('ok');
    expect(r.shape).toEqual(['defineModule', 'dispose', 'evaluate', 'iframe', 'isDisposed', 'stats']);
    expect(r.disposed).toBe(false);
  });

  test('results come back by structured clone', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const sb = await make();
      const v = await sb.evaluate(`return {
        map: new Map([['a', 1]]), set: new Set([1, 2]), date: new Date(0),
        bytes: new Uint8Array([1, 2, 3]), nested: { arr: [1, { x: 'y' }] }, fn: undefined,
      }`);
      return {
        map: v.map instanceof Map && v.map.get('a') === 1,
        set: v.set instanceof Set && v.set.has(2),
        date: v.date instanceof Date && v.date.getTime() === 0,
        bytes: v.bytes instanceof Uint8Array && [...v.bytes].join() === '1,2,3',
        nested: v.nested.arr[1].x,
        fn: await sb.evaluate('return () => 1'),
        node: await settle(sb.evaluate('return document.body')),
        thrown: await settle(sb.evaluate('throw new TypeError("boom")')),
      };
    });
    expect(r).toMatchObject({ map: true, set: true, date: true, bytes: true, nested: 'y', fn: '[Function]' });
    expect(r.node).toMatchObject({ ok: false, name: 'DataCloneError' });
    expect(r.thrown).toMatchObject({ ok: false, name: 'TypeError', message: 'boom' });
  });

  test('host.call reaches capabilities, through the gate', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const sb = await make({
        capabilities: {
          add: (a, b) => a + b,
          echo: (x) => x,
          whoami() { return this.name + ':' + (this.signal instanceof AbortSignal); },
        },
        policy: { capabilities: { add: { maxCalls: 2 } } },
      });
      const echoed = await sb.evaluate('return await host.call("echo", { d: new Date(5), m: new Map([[1, 2]]) })');
      return {
        add: await sb.evaluate('return [await host.call("add", 2, 3), await host.call("add", 1, 1)]'),
        limited: await settle(sb.evaluate('return await host.call("add", 1, 1)')),
        echoDate: echoed.d instanceof Date && echoed.d.getTime() === 5,
        echoMap: echoed.m instanceof Map && echoed.m.get(1) === 2,
        context: await sb.evaluate('return await host.call("whoami")'),
        unknown: await settle(sb.evaluate('return await host.call("nope")')),
        proto: await settle(sb.evaluate('return await host.call("constructor")')),
        gate: sb.stats().gate.perCapability.add.calls,
      };
    });
    expect(r.add).toEqual([5, 2]);
    expect(r.limited.ok).toBe(false);
    expect(r.echoDate).toBe(true);
    expect(r.echoMap).toBe(true);
    expect(r.context).toBe('whoami:true');
    expect(r.unknown).toMatchObject({ ok: false, message: 'Unknown capability: nope' });
    expect(r.proto).toMatchObject({ ok: false, message: 'Unknown capability: constructor' });
    expect(r.gate).toBeGreaterThanOrEqual(2);
  });

  test('console is forwarded to onConsole, sandbox-level and per evaluate()', async ({ page }) => {
    const r = await host(page, async (make) => {
      const sandboxLog = [];
      const callLog = [];
      const sb = await make({ onConsole: (level, ...args) => sandboxLog.push([level, ...args]) });
      await sb.evaluate('console.log("a", 1, { k: 2 }); console.warn("w"); console.error("e")');
      await sb.evaluate('console.info("only here")', { onConsole: (level, ...args) => callLog.push([level, ...args]) });
      await sb.evaluate('console.debug("back")');
      return { sandboxLog, callLog };
    });
    expect(r.sandboxLog).toEqual([['log', 'a', '1', '{"k":2}'], ['warn', 'w'], ['error', 'e'], ['debug', 'back']]);
    expect(r.callLog).toEqual([['info', 'only here']]);
  });

  test('a timeout rejects with TimeoutError, replaces the iframe, and the next call works', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const frames = [];
      let capSignal = null;
      const sb = await make({
        defaultTimeoutMs: 400,
        onFrame: (f) => frames.push(f),
        capabilities: { hang() { capSignal = this.signal; return new Promise(() => {}); } },
      });
      await sb.evaluate('globalThis.marker = 1');
      const first = sb.iframe;
      const t0 = performance.now();
      const timedOut = await settle(sb.evaluate('await new Promise(() => {})', { timeoutMs: 300 }));
      const elapsed = performance.now() - t0;
      const second = sb.iframe;
      const replaced = first !== second && !first.isConnected && second.isConnected;
      const byDefault = await settle(sb.evaluate('await host.call("hang")'));
      return {
        timedOut, byDefault, elapsed, replaced,
        onFrameCalls: frames.length,
        capabilityAborted: capSignal?.aborted,
        fresh: await sb.evaluate('return typeof globalThis.marker'),
        iframes: document.querySelectorAll('iframe').length,
      };
    });
    expect(r.timedOut).toMatchObject({ ok: false, name: 'TimeoutError', message: 'Sandbox execution timed out after 300ms' });
    expect(r.elapsed).toBeLessThan(5000);
    expect(r.byDefault).toMatchObject({ ok: false, name: 'TimeoutError', message: 'Sandbox execution timed out after 400ms' });
    expect(r.replaced).toBe(true);
    expect(r.onFrameCalls).toBe(3);
    expect(r.capabilityAborted).toBe(true);
    expect(r.fresh).toBe('undefined');
    expect(r.iframes).toBe(1);
  });

  test('a synchronous infinite loop is hard-killed when the browser runs the frame off the host thread', async ({ page }) => {
    // Probe: does the host's event loop keep running while the frame is busy?
    const ticks = await host(page, async (make) => {
      const sb = await make();
      let n = 0;
      const iv = setInterval(() => n++, 10);
      await sb.evaluate('const t = Date.now(); while (Date.now() - t < 400) {}');
      clearInterval(iv);
      // Dispose before the real test: Chrome groups sandboxed frames of one
      // site into one process, and a looping frame's process can only be
      // killed once no other frame lives in it (README Security model).
      await sb.dispose();
      return n;
    });
    test.skip(ticks < 10, `this engine runs the sandboxed frame on the host's thread (${ticks} host ticks in 400ms): ` +
      'a synchronous infinite loop would freeze the host page too (documented in README Security model)');
    const r = await host(page, async (make, settle) => {
      const sb = await make();
      const t0 = performance.now();
      const loop = await settle(sb.evaluate('while (true) {}', { timeoutMs: 300 }));
      const elapsed = performance.now() - t0;
      const t1 = performance.now();
      const after = await sb.evaluate('return "alive"');
      return { loop, elapsed, after, restartMs: performance.now() - t1 };
    });
    expect(r.loop).toMatchObject({ ok: false, name: 'TimeoutError' });
    expect(r.elapsed).toBeLessThan(5000);
    expect(r.after).toBe('alive');
    expect(r.restartMs).toBeLessThan(5000);
  });

  test('an AbortSignal rejects with AbortError and restarts the frame', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const sb = await make();
      const first = sb.iframe;
      const ac = new AbortController();
      const pending = settle(sb.evaluate('await new Promise(() => {})', { signal: ac.signal }));
      setTimeout(() => ac.abort(), 50);
      const aborted = await pending;
      const preAborted = await settle(sb.evaluate('return 1', { signal: AbortSignal.abort() }));
      return { aborted, preAborted, replaced: sb.iframe !== first, after: await sb.evaluate('return "ok"') };
    });
    expect(r.aborted).toMatchObject({ ok: false, name: 'AbortError', isDOMException: true });
    expect(r.preAborted).toMatchObject({ ok: false, name: 'AbortError', isDOMException: true });
    expect(r.replaced).toBe(true);
    expect(r.after).toBe('ok');
  });

  test('code has the frame\'s own document: it renders visibly into a container', async ({ page }) => {
    const r = await host(page, async (make) => {
      const pane = document.getElementById('pane');
      const sb = await make({ container: pane, html: '<p id="pre">preset markup</p>' });
      sb.iframe.style.cssText = 'width:400px;height:200px;border:0';
      const inside = await sb.evaluate(`
        const h = document.createElement('h1');
        h.id = 'title';
        h.textContent = 'Rendered in the frame';
        document.body.append(h);
        const canvas = document.createElement('canvas');
        canvas.width = 20; canvas.height = 20;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgb(255, 0, 0)'; ctx.fillRect(0, 0, 20, 20);
        document.body.append(canvas);
        return {
          pre: document.getElementById('pre').textContent,
          hasWindow: typeof window === 'object' && window === globalThis && typeof self === 'object',
          pixel: [...ctx.getImageData(5, 5, 1, 1).data],
          fetchType: typeof fetch,
        };
      `);
      return { inside, inPane: sb.iframe.parentElement === pane, defaultPlacement: false };
    });
    expect(r.inside).toEqual({ pre: 'preset markup', hasWindow: true, pixel: [255, 0, 0, 255], fetchType: 'function' });
    expect(r.inPane).toBe(true);
    // Visible to the user, not just in a detached tree.
    const frame = page.frameLocator('#pane iframe');
    await expect(frame.locator('#title')).toHaveText('Rendered in the frame');
    await expect(frame.locator('#title')).toBeVisible();
    await expect(frame.locator('#pre')).toHaveText('preset markup');
  });

  test('the frame is an opaque origin: no access to the host document, storage or cookies', async ({ page }) => {
    const r = await host(page, async (make) => {
      localStorage.setItem('andbox-secret', 's3cret');
      document.cookie = 'andbox_secret=s3cret; path=/';
      const sb = await make();
      const seen = await sb.evaluate(`
        const probe = (f) => { try { return 'READ:' + String(f()); } catch (e) { return e.name; } };
        return {
          origin: self.origin,
          parentDocument: probe(() => parent.document.title),
          parentStorage: probe(() => parent.localStorage.getItem('andbox-secret')),
          topLocation: probe(() => top.location.href),
          ownStorage: probe(() => localStorage.getItem('andbox-secret')),
          ownCookie: probe(() => document.cookie),
          frameElement: probe(() => window.frameElement),
          sandboxAttr: probe(() => window.frameElement.getAttribute('sandbox')),
        };
      `);
      return { seen, attr: sb.iframe.getAttribute('sandbox') };
    });
    expect(r.attr).toBe('allow-scripts');
    expect(r.seen.origin).toBe('null');
    for (const key of ['parentDocument', 'parentStorage', 'topLocation', 'ownStorage']) {
      expect(r.seen[key], key).toBe('SecurityError');
    }
    // Chromium and Firefox throw; WebKit returns an empty cookie string.
    expect(['SecurityError', 'READ:']).toContain(r.seen.ownCookie);
    expect(r.seen.frameElement).toBe('READ:null');
    expect(JSON.stringify(r)).not.toContain('s3cret');
  });

  test('sandboxImport: virtual modules, the import map, and remote URLs under allowedImportHosts', async ({ page }) => {
    const r = await host(page, async (make, settle, REMOTE) => {
      const open = await make({ importMap: { imports: { 'remote-lib': REMOTE } } });
      await open.defineModule('greet', 'export default (n) => "hi " + n;');
      const denyAll = await make({ allowedImportHosts: [] });
      const allowLocalhost = await make({ allowedImportHosts: ['localhost'] });
      return {
        virtual: await open.evaluate('return (await sandboxImport("greet")).default("there")'),
        mapped: await open.evaluate('return (await sandboxImport("remote-lib")).greeting'),
        remote: await open.evaluate(`return (await sandboxImport(${JSON.stringify(REMOTE)})).default(21)`),
        relativeToBase: await denyAll.evaluate('return (await sandboxImport("./fixtures/remote-module.mjs")).greeting'),
        denied: await settle(denyAll.evaluate(`return await sandboxImport(${JSON.stringify(REMOTE)})`)),
        allowed: await allowLocalhost.evaluate(`return (await sandboxImport(${JSON.stringify(REMOTE)})).greeting`),
        unresolvable: await settle(open.evaluate('return await sandboxImport("left-pad")')),
        modules: open.stats().virtualModules,
      };
    }, REMOTE);
    expect(r.virtual).toBe('hi there');
    expect(r.mapped).toBe('hello from a remote module');
    expect(r.remote).toBe(42);
    expect(r.relativeToBase).toBe('hello from a remote module');
    expect(r.denied).toMatchObject({ ok: false, message: 'Import denied: localhost is not in allowedImportHosts' });
    expect(r.allowed).toBe('hello from a remote module');
    expect(r.unresolvable.message).toMatch(/Cannot resolve module: left-pad/);
    expect(r.modules).toEqual(['greet']);
  });

  test('sandboxImport of a module from the public internet (skipped offline)', async ({ page }) => {
    const url = 'https://esm.sh/ms@2.1.3';
    const online = await fetch(url, { signal: AbortSignal.timeout(5000) }).then((res) => res.ok, () => false);
    test.skip(!online, `no network access to ${url}`);
    const r = await host(page, async (make, settle, url) => {
      const sb = await make();
      return settle(sb.evaluate(`const { default: ms } = await sandboxImport(${JSON.stringify(url)}); return ms('2s')`));
    }, url);
    expect(r).toEqual({ ok: true, value: 2000 });
  });

  test('csp is applied inside the frame (here: no network), and evaluate still works', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const strict = await make({ csp: "default-src 'none'; script-src 'unsafe-eval'" });
      const open = await make();
      const probe = 'try { await fetch(location.origin === "null" ? document.baseURI : "/", { cache: "no-store" }); return "fetched"; } catch (e) { return "blocked"; }';
      return {
        strict: await strict.evaluate(probe),
        open: await open.evaluate(probe),
        works: await strict.evaluate('return 6 * 7'),
        meta: await strict.evaluate('return document.querySelector("meta[http-equiv=Content-Security-Policy]").content'),
      };
    });
    expect(r.strict).toBe('blocked');
    // Without csp the network is still the frame's (README: "What is still yours").
    expect(r.open).toBe('fetched');
    expect(r.works).toBe(42);
    expect(r.meta).toBe("default-src 'none'; script-src 'unsafe-eval'");
  });

  test('iframeSandbox adds tokens; allow-same-origin needs the explicit opt-in', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const extra = await make({ iframeSandbox: ['allow-forms', 'allow-popups'] });
      const refused = await settle(make({ iframeSandbox: ['allow-same-origin'] }));
      const bad = await settle(make({ iframeSandbox: ['allow-forms allow-same-origin'] }));
      const unsafe = await make({ iframeSandbox: ['allow-same-origin'], dangerouslyAllowSameOrigin: true });
      return {
        attr: extra.iframe.getAttribute('sandbox'),
        refused, bad,
        unsafeOrigin: await unsafe.evaluate('return self.origin'),
        hostOrigin: location.origin,
        leftover: document.querySelectorAll('iframe').length,
      };
    });
    expect(r.attr).toBe('allow-scripts allow-forms allow-popups');
    expect(r.refused).toMatchObject({ ok: false });
    expect(r.refused.message).toMatch(/dangerouslyAllowSameOrigin/);
    expect(r.bad).toMatchObject({ ok: false, name: 'TypeError' });
    // The opt-in really does remove the boundary: same origin as the host.
    expect(r.unsafeOrigin).toBe(r.hostOrigin);
    expect(r.leftover).toBe(2);
  });

  test('placement: default offscreen, onFrame can mount it, restarts keep position and attributes', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const plain = await make();
      const defaultSpot = {
        parent: plain.iframe.parentElement === document.body,
        hidden: plain.iframe.getAttribute('aria-hidden'),
        offscreen: plain.iframe.getBoundingClientRect().right <= 0,
      };

      const slot = document.createElement('section');
      document.body.append(slot);
      const mounted = await make({ onFrame: (f) => { f.className = 'mine'; slot.append(f); } });
      const mountedOk = mounted.iframe.parentElement === slot && mounted.iframe.className === 'mine';

      const pane = document.createElement('div');
      pane.innerHTML = '<span id="a"></span>';
      document.body.append(pane);
      const sb = await make({ container: pane });
      pane.append(Object.assign(document.createElement('span'), { id: 'b' }));
      sb.iframe.className = 'cell';
      sb.iframe.style.height = '123px';
      const before = sb.iframe;
      await settle(sb.evaluate('await new Promise(() => {})', { timeoutMs: 100 }));
      const after = sb.iframe;
      return {
        defaultSpot, mountedOk,
        replaced: before !== after,
        between: after.previousElementSibling?.id + '|' + after.nextElementSibling?.id,
        className: after.className,
        height: after.style.height,
        sandbox: after.getAttribute('sandbox'),
      };
    });
    expect(r.defaultSpot).toEqual({ parent: true, hidden: 'true', offscreen: true });
    expect(r.mountedOk).toBe(true);
    expect(r.replaced).toBe(true);
    expect(r.between).toBe('a|b');
    expect(r.className).toBe('cell');
    expect(r.height).toBe('123px');
    expect(r.sandbox).toBe('allow-scripts');
  });

  test('a frame that navigates or reloads fails its pending call, and the next call recovers', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const sb = await make({ defaultTimeoutMs: 10_000 });
      const t0 = performance.now();
      const reloaded = await settle(sb.evaluate('setTimeout(() => location.reload(), 0); await new Promise(() => {})'));
      return { reloaded, elapsed: performance.now() - t0, after: await sb.evaluate('return "ok"') };
    });
    expect(r.reloaded).toMatchObject({ ok: false });
    expect(r.reloaded.message).toMatch(/unloaded/);
    expect(r.elapsed).toBeLessThan(5000);
    expect(r.after).toBe('ok');
  });

  test('startup failure rejects createSandbox() and leaves nothing behind', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const detached = document.createElement('div');
      const failed = await settle(make({ container: detached, defaultTimeoutMs: 300 }));
      return { failed, children: detached.children.length };
    });
    expect(r.failed).toMatchObject({ ok: false });
    expect(r.failed.message).toMatch(/did not start within 300ms/);
    expect(r.children).toBe(0);
  });

  test('dispose() removes the frame and rejects pending and later calls', async ({ page }) => {
    const r = await host(page, async (make, settle) => {
      const sb = await make();
      const frame = sb.iframe;
      const pending = settle(sb.evaluate('await new Promise(() => {})'));
      await sb.dispose();
      await sb.dispose(); // idempotent
      return {
        pending: await pending,
        later: await settle(sb.evaluate('return 1')),
        iframe: sb.iframe,
        connected: frame.isConnected,
        disposed: sb.isDisposed(),
        stats: sb.stats().disposed,
      };
    });
    expect(r.pending).toMatchObject({ ok: false, message: 'Sandbox disposed' });
    expect(r.later).toMatchObject({ ok: false, message: 'Sandbox is disposed' });
    expect(r.iframe).toBeNull();
    expect(r.connected).toBe(false);
    expect(r.disposed).toBe(true);
    expect(r.stats).toBe(true);
  });

  test('a forged handshake from another frame is ignored', async ({ page }) => {
    const r = await host(page, async (make) => {
      // Another opaque frame floods the parent with hello messages; it does
      // not know the token and is not the sandbox's contentWindow.
      const rogue = document.createElement('iframe');
      rogue.sandbox = 'allow-scripts';
      rogue.srcdoc = '<script>setInterval(() => parent.postMessage({ type: "andbox:hello", token: "guess" }, "*"), 1)<\/script>';
      document.body.append(rogue);
      const sb = await make();
      const value = await sb.evaluate('return "real"');
      rogue.remove();
      return value;
    });
    expect(r).toBe('real');
  });
});
