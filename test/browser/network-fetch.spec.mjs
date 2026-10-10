// #39: createSandbox({ network }) in real browsers (Chromium, Firefox, WebKit),
// for a browser Worker (mode: 'worker') and a sandboxed iframe (mode: 'iframe').
//
// The host page is test/browser/fixture.html on 127.0.0.1; `fetch` inside the
// sandbox is andbox's shim, which sends each request to the host function.
// `network.allowedHosts` is required (#43); tests that only exercise the shim
// pass '*' with a recording host fetch.
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
function host(page, mode, fn, arg) {
  return page.evaluate(
    async ([m, src, a]) => {
      window.open_ ??= [];
      const make = async (opts = {}) => {
        const sb = await window.andbox.createSandbox({ mode: m, ...opts });
        window.open_.push(sb);
        return sb;
      };
      // A host fetch that records what the sandbox asked for.
      const recorder = () => {
        const seen = [];
        const hostFetch = async (url, init) => {
          seen.push({
            url,
            method: init.method,
            headers: Object.fromEntries(init.headers),
            body: init.body === undefined ? null : typeof init.body === 'string' ? init.body : [...init.body],
            credentials: init.credentials,
          });
          return new Response(JSON.stringify({ url }), { headers: { 'content-type': 'application/json' } });
        };
        return { seen, hostFetch };
      };
      return (0, eval)(`(${src})`)(make, recorder, a);
    },
    [mode, fn.toString(), arg],
  );
}

const LIBRARY = `
export async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
`;

for (const mode of ['worker', 'iframe']) {
  test.describe(`network fetch, mode: '${mode}'`, () => {
    test('a library calling the global fetch goes through the host function, which sees every request', async ({ page }) => {
      const r = await host(page, mode, async (make, recorder, lib) => {
        const { seen, hostFetch } = recorder();
        const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
        await sb.defineModule('lib', lib);
        const value = await sb.evaluate(`
          const { getJSON } = await sandboxImport('lib');
          const a = await getJSON('https://api.example.com/a', { headers: { 'x-trace': '1' } });
          const res = await fetch('https://api.example.com/b', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
          return { a, isResponse: res instanceof Response, status: res.status, url: res.url, typeofFetch: typeof globalThis.fetch };
        `);
        return { value, seen };
      }, LIBRARY);
      expect(r.value).toEqual({
        a: { url: 'https://api.example.com/a' }, isResponse: true, status: 200,
        url: 'https://api.example.com/b', typeofFetch: 'function',
      });
      expect(r.seen.map((s) => [s.method, s.url])).toEqual([
        ['GET', 'https://api.example.com/a'],
        ['POST', 'https://api.example.com/b'],
      ]);
      expect(r.seen[0].headers['x-trace']).toBe('1');
      expect(r.seen[1].body).toEqual([1, 2, 3]);
    });

    test('non-http(s) URLs are refused and credentials cannot be forced', async ({ page }) => {
      const r = await host(page, mode, async (make, recorder) => {
        const { seen, hostFetch } = recorder();
        const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
        const refused = await sb.evaluate(`
          const out = [];
          for (const u of ['data:text/plain,hi', 'blob:null/x', 'file:///etc/passwd', 'javascript:1']) {
            try { await fetch(u); out.push('fetched'); } catch (e) { out.push(e.name); }
          }
          return out;
        `);
        const direct = await sb.evaluate("try { await host.call('fetch', 'file:///etc/passwd', {}); } catch (e) { return e.message }");
        const before = seen.length;
        await sb.evaluate(`
          await fetch('https://x.example/1', { credentials: 'include' });
          await fetch(new Request('https://x.example/2', { credentials: 'include' }));
          await host.call('fetch', 'https://x.example/3', { headers: [], credentials: 'include' });
        `);
        return { refused, direct, before, credentials: seen.map((s) => s.credentials) };
      });
      expect(r.refused).toEqual(['TypeError', 'TypeError', 'TypeError', 'TypeError']);
      expect(r.direct).toMatch(/only http\(s\) URLs are allowed/);
      expect(r.before).toBe(0);
      expect(r.credentials).toEqual(['omit', 'omit', 'omit']);
    });

    test('network.allowedHosts uses the page\'s fetch through createNetworkFetch(); the page\'s fetch works as network.fetch', async ({ page }) => {
      const r = await host(page, mode, async (make) => {
        const sb = await make({ network: { allowedHosts: ['127.0.0.1'] } });
        const origin = location.origin; // http://127.0.0.1:<port>
        const name = await sb.evaluate(`return (await (await fetch('${origin}/package.json')).json()).name`);
        const denied = await sb.evaluate(`try { await fetch('${origin.replace('127.0.0.1', 'localhost')}/package.json') } catch (e) { return e.message }`);
        // The page's own fetch can be passed directly (no "Illegal invocation").
        const direct = await make({ network: { allowedHosts: '*', fetch } });
        const version = await direct.evaluate(`return (await (await fetch('${origin}/package.json')).json()).version`);
        return { name, denied, version };
      });
      expect(r.name).toBe('@johnhenry/andbox');
      expect(r.denied).toMatch(/localhost is not in the allowlist/);
      expect(r.version).toMatch(/^\d+\.\d+\.\d+/);
    });

    test('network without allowedHosts is refused before a sandbox starts (#43)', async ({ page }) => {
      const r = await host(page, mode, async (make, recorder) => {
        const { seen, hostFetch } = recorder();
        let message = 'created';
        try {
          await make({ network: { fetch: hostFetch } });
        } catch (e) {
          message = e.message;
        }
        return { message, frames: document.querySelectorAll('iframe').length, seen: seen.length };
      });
      expect(r.message).toMatch(/network\.allowedHosts is required/);
      expect(r.message).toContain("allowedHosts: '*'");
      expect(r.frames).toBe(0);
      expect(r.seen).toBe(0);
    });

    test('allowedHosts as a function is asked per request, so the allowlist can change at runtime (#43)', async ({ page }) => {
      const r = await host(page, mode, async (make) => {
        const allowed = new Set(['127.0.0.1']);
        const asked = [];
        const sb = await make({ network: { allowedHosts: (url) => { asked.push(url.host); return allowed.has(url.hostname); } } });
        const origin = location.origin;
        const other = origin.replace('127.0.0.1', 'localhost');
        const get = `async (u) => { try { return (await (await fetch(u)).json()).name } catch (e) { return e.message } }`;
        const first = await sb.evaluate(`return (${get})('${origin}/package.json')`);
        const before = await sb.evaluate(`return (${get})('${other}/package.json')`);
        allowed.add('localhost');
        const after = await sb.evaluate(`return (${get})('${other}/package.json')`);
        return { first, before, after, asked: asked.length };
      });
      expect(r.first).toBe('@johnhenry/andbox');
      expect(r.before).toMatch(/localhost:\d+ is not allowed by network\.allowedHosts/);
      expect(r.after).toBe('@johnhenry/andbox');
      expect(r.asked).toBe(3);
    });

    test("redirects: refused for a list, fail closed for a function over the browser's fetch, the caller's choice for '*' (#43)", async ({ page }) => {
      const r = await host(page, mode, async (make) => {
        const url = `${location.origin}/__redirect?to=/package.json`;
        const run = async (network) => {
          const sb = await make({ network });
          return sb.evaluate(`try { const res = await fetch('${url}'); return [res.redirected, (await res.json()).name] } catch (e) { return e.message }`);
        };
        return {
          list: await run({ allowedHosts: ['127.0.0.1'] }),
          fn: await run({ allowedHosts: () => true }),
          any: await run({ allowedHosts: '*', fetch }),
        };
      });
      expect(r.list).toMatch(/redirects are not followed/);
      expect(r.fn).toMatch(/hides, so network\.allowedHosts cannot check it/);
      expect(r.any).toEqual([true, '@johnhenry/andbox']);
    });
  });
}

test("worker mode: everything else stays locked with network on", async ({ page }) => {
  const r = await host(page, 'worker', async (make, recorder) => {
    const sb = await make({ network: { allowedHosts: '*', fetch: recorder().hostFetch } });
    return sb.evaluate(`return ['XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel']
      .map((n) => typeof globalThis[n])`);
  });
  expect(new Set(r)).toEqual(new Set(['undefined']));
});

test("iframe mode: the shim replaces the frame's fetch, so it works under csp connect-src 'none'", async ({ page }) => {
  const r = await host(page, 'iframe', async (make, recorder) => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch }, csp: "connect-src 'none'" });
    const value = await sb.evaluate("return (await fetch('https://api.example.com/c')).json()");
    // XHR is the frame's own and the CSP blocks it: network goes through the host or nowhere.
    const xhr = await sb.evaluate(`
      return await new Promise((resolve) => {
        const x = new XMLHttpRequest();
        x.onload = () => resolve('loaded');
        x.onerror = () => resolve('blocked');
        try { x.open('GET', 'https://api.example.com/c'); x.send(); } catch { resolve('blocked'); }
      });
    `);
    return { value, xhr, seen: seen.length };
  });
  expect(r.value).toEqual({ url: 'https://api.example.com/c' });
  expect(r.xhr).toBe('blocked');
  expect(r.seen).toBe(1);
});
