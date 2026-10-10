/**
 * #39: createSandbox({ network }) installs a global `fetch` in the sandbox
 * that goes through a host function, via the gated `fetch` capability.
 *
 * These run the real runtime on node:worker_threads (the same script a browser
 * Worker runs, with the same lockdown). test/browser/network-fetch.spec.mjs
 * covers browser Workers and mode: 'iframe' in Chromium, Firefox and WebKit.
 */
import { describe, it, afterEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createSandbox, makeWorkerSource } from '../src/index.mjs';
import { createFetchCapability } from '../src/network-policy.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

/** A host fetch that records every request and answers with JSON. */
function recorder(reply = (url) => Response.json({ url })) {
  const seen = [];
  function hostFetch(url, init) {
    assert.equal(this, undefined, 'called without a receiver, so a native fetch can be passed');
    seen.push({
      url,
      method: init.method,
      headers: Object.fromEntries(init.headers),
      body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : [...init.body],
      credentials: init.credentials,
      signal: init.signal instanceof AbortSignal,
    });
    return reply(url, init);
  }
  return { seen, hostFetch };
}

const LIBRARY = `
// A library that knows nothing about andbox: it uses the global fetch.
export async function getJSON(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}
`;

describe('#39 network: default behaviour is unchanged', () => {
  it('without the option fetch stays removed and there is no fetch capability', async () => {
    const sb = await make();
    assert.equal(await sb.evaluate('return typeof fetch + typeof globalThis.fetch'), 'undefinedundefined');
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'https://example.com/', {})"), /Unknown capability: fetch/);
  });

  it('makeWorkerSource() with no options is the same script as before', () => {
    assert.equal(makeWorkerSource(), makeWorkerSource({ networkFetch: false }));
    assert.ok(!makeWorkerSource().includes('installNetworkFetch'));
    assert.ok(makeWorkerSource({ networkFetch: true }).includes('installNetworkFetch'));
  });
});

describe('#39 network: a library-style global fetch goes through the host function', () => {
  it('an imported module calling the global fetch works, and the host sees the request', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch } });
    await sb.defineModule('lib', LIBRARY);
    const r = await sb.evaluate(`
      const { getJSON } = await sandboxImport('lib');
      return getJSON('https://api.example.com/items?x=1', { headers: { 'x-trace': 'abc' } });
    `);
    assert.deepEqual(r, { url: 'https://api.example.com/items?x=1' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, 'https://api.example.com/items?x=1');
    assert.equal(seen[0].method, 'GET');
    assert.equal(seen[0].headers['x-trace'], 'abc');
    assert.equal(seen[0].signal, true, 'init.signal aborts when the worker is terminated');
  });

  it('fetch is a function by name, via globalThis, indirect eval and Function; the rest stays locked', async () => {
    const sb = await make({ network: { fetch: recorder().hostFetch } });
    const r = await sb.evaluate(`return [
      typeof fetch, typeof globalThis.fetch, (0, eval)('typeof fetch'), new Function('return typeof fetch')(),
      fetch === globalThis.fetch,
    ]`);
    assert.deepEqual(r, ['function', 'function', 'function', 'function', true]);
    for (const name of ['XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource',
      'Worker', 'SharedWorker', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'postMessage', 'self']) {
      assert.equal(await sb.evaluate(`return typeof ${name} + typeof globalThis.${name}`), 'undefinedundefined', name);
    }
  });

  it('returns a real Response: status, statusText, headers, url, redirected, body readers', async () => {
    const sb = await make({
      network: {
        fetch: () => ({
          status: 201, statusText: 'Created', url: 'https://api.example.com/final', redirected: true,
          headers: [['content-type', 'text/plain'], ['x-a', '1']], body: 'hello',
        }),
      },
    });
    const r = await sb.evaluate(`
      const res = await fetch('https://api.example.com/start');
      return {
        isResponse: res instanceof Response, ok: res.ok, status: res.status, statusText: res.statusText,
        type: res.headers.get('content-type'), xa: res.headers.get('x-a'), url: res.url, redirected: res.redirected,
        text: await res.clone().text(), bytes: [...new Uint8Array(await res.arrayBuffer())].length,
      };
    `);
    assert.deepEqual(r, {
      isResponse: true, ok: true, status: 201, statusText: 'Created', type: 'text/plain', xa: '1',
      url: 'https://api.example.com/final', redirected: true, text: 'hello', bytes: 5,
    });
  });

  it('serialises bodies: strings, typed arrays, URLSearchParams, FormData and Request objects', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch } });
    await sb.evaluate(`
      const u = 'https://api.example.com/post';
      await fetch(u, { method: 'POST', body: JSON.stringify({ a: 1 }), headers: { 'content-type': 'application/json' } });
      await fetch(u, { method: 'POST', body: new Uint8Array([0, 255, 7]) });
      await fetch(u, { method: 'POST', body: new URLSearchParams({ q: 'x y' }) });
      const fd = new FormData(); fd.append('k', 'v');
      await fetch(u, { method: 'POST', body: fd });
      await fetch(new Request(u, { method: 'PUT', body: 'from-request', headers: { 'x-r': '1' } }));
      await fetch(u, { method: 'HEAD' });
    `);
    assert.equal(seen.length, 6);
    assert.equal(seen[0].body, '{"a":1}');
    assert.equal(seen[0].headers['content-type'], 'application/json');
    assert.deepEqual(seen[1].body, [0, 255, 7]);
    assert.equal(Buffer.from(seen[2].body).toString(), 'q=x+y');
    assert.match(seen[2].headers['content-type'], /application\/x-www-form-urlencoded/);
    assert.match(seen[3].headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(Buffer.from(seen[3].body).toString(), /name="k"\r\n\r\nv/);
    assert.equal(seen[4].method, 'PUT');
    assert.equal(Buffer.from(seen[4].body).toString(), 'from-request');
    assert.equal(seen[4].headers['x-r'], '1');
    assert.equal(seen[5].method, 'HEAD');
    assert.equal(seen[5].body, undefined);
  });

  it('relative URLs resolve against baseURL (a blob: worker has no usable base of its own)', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ baseURL: 'https://app.example.com/notebook/', network: { fetch: hostFetch } });
    await sb.evaluate("await fetch('data.json'); await fetch('/api/v1')");
    assert.deepEqual(seen.map((s) => s.url), ['https://app.example.com/notebook/data.json', 'https://app.example.com/api/v1']);
  });

  it('null-body statuses and a host Response both work', async () => {
    const sb = await make({ network: { fetch: () => new Response(null, { status: 204 }) } });
    assert.deepEqual(await sb.evaluate("const r = await fetch('https://x.example/'); return [r.status, await r.text()]"), [204, '']);
  });

  it('the shim is reinstalled in the fresh worker after a timeout kill', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch } });
    await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 100 }), /timed out/i);
    assert.deepEqual(await sb.evaluate("return (await fetch('https://x.example/a')).json()"), { url: 'https://x.example/a' });
    assert.equal(seen.length, 1);
  });
});

describe('#39 network: what the sandbox cannot do', () => {
  it('non-http(s) URLs are refused in the sandbox, and the host function is never called', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch } });
    for (const url of ['data:text/plain,hi', 'file:///etc/passwd', 'blob:https://x.example/1', 'javascript:1', 'ftp://x.example/']) {
      const r = await sb.evaluate(`try { await fetch(${JSON.stringify(url)}); return 'fetched'; } catch (e) { return e.name + ': ' + e.message; }`);
      assert.match(r, /^TypeError: fetch: only http\(s\) URLs are allowed/, url);
    }
    assert.equal(seen.length, 0);
  });

  it('non-http(s) URLs are refused by the host too, when the capability is called directly', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch } });
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'file:///etc/passwd', {})"), /only http\(s\) URLs are allowed/);
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'not a url', {})"), /invalid URL/);
    await assert.rejects(() => sb.evaluate("return host.call('fetch', ['https://x.example/'], {})"), /must be a string/);
    assert.equal(seen.length, 0);
  });

  it('credentials cannot be forced from inside: init, a Request, or a direct host.call', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch } });
    await sb.evaluate(`
      await fetch('https://x.example/1', { credentials: 'include' });
      await fetch(new Request('https://x.example/2', { credentials: 'include' }));
      await host.call('fetch', 'https://x.example/3', { method: 'GET', headers: [], credentials: 'include' });
    `);
    assert.deepEqual(seen.map((s) => s.credentials), ['omit', 'omit', 'omit']);
  });

  it('the host decides credentials (network.credentials)', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch, credentials: 'same-origin' } });
    await sb.evaluate("await fetch('https://x.example/', { credentials: 'omit' })");
    assert.equal(seen[0].credentials, 'same-origin');
  });

  it('Set-Cookie never reaches the sandbox', async () => {
    const sb = await make({
      network: { fetch: () => new Response('x', { headers: { 'set-cookie': 'sid=secret', 'x-ok': '1' } }) },
    });
    const r = await sb.evaluate("const r = await fetch('https://x.example/'); return [r.headers.get('set-cookie'), r.headers.get('x-ok')]");
    assert.deepEqual(r, [null, '1']);
  });

  it('host errors surface as a TypeError, like a failed fetch', async () => {
    const sb = await make({ network: { fetch: () => { throw new Error('blocked by policy'); } } });
    const r = await sb.evaluate("try { await fetch('https://x.example/'); } catch (e) { return [e.name, e.message]; }");
    assert.deepEqual(r, ['TypeError', 'fetch failed: blocked by policy']);
  });

  it('an AbortSignal rejects the sandbox fetch with AbortError', async () => {
    const sb = await make({ network: { fetch: () => new Promise(() => {}) } });
    const r = await sb.evaluate(`
      const ac = new AbortController();
      const p = fetch('https://x.example/', { signal: ac.signal });
      ac.abort();
      try { await p; } catch (e) { return e.name; }
    `);
    assert.equal(r, 'AbortError');
    assert.equal(await sb.evaluate("try { await fetch('https://x.example/', { signal: AbortSignal.abort() }) } catch (e) { return e.name }"), 'AbortError');
  });

  it('goes through the capability gate and policy', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch }, policy: { capabilities: { fetch: { maxCalls: 2, maxArgBytes: 2000 } } } });
    await sb.evaluate("await fetch('https://x.example/1'); await fetch('https://x.example/2')");
    const r = await sb.evaluate("try { await fetch('https://x.example/3') } catch (e) { return e.message }");
    assert.match(r, /Capability 'fetch' call limit exceeded/);
    assert.equal(seen.length, 2);
    assert.equal(sb.stats().gate.perCapability.fetch.calls, 2);
  });

  it('binary request bodies count toward the gate\'s argument-size limit', async () => {
    const sb = await make({ network: { fetch: recorder().hostFetch }, policy: { capabilities: { fetch: { maxArgBytes: 1000 } } } });
    const r = await sb.evaluate("try { await fetch('https://x.example/', { method: 'POST', body: new Uint8Array(4096) }) } catch (e) { return e.message }");
    assert.match(r, /argument size exceeded/);
  });
});

describe('#39 network.allowedHosts: createNetworkFetch() as the host function', () => {
  let server;
  let port;
  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${port}/data` }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'sid=1' });
      res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  it('allowed hosts reach the network; others and redirects are refused', async () => {
    const sb = await make({ network: { allowedHosts: ['127.0.0.1'] } });
    await sb.defineModule('lib', LIBRARY);
    const ok = await sb.evaluate(`const { getJSON } = await sandboxImport('lib'); return getJSON('http://127.0.0.1:${port}/data')`);
    assert.deepEqual(ok, { path: '/data', cookie: null });
    await assert.rejects(
      () => sb.evaluate(`return (await fetch('http://localhost:${port}/data')).json()`),
      /localhost is not in the allowlist/,
    );
    await assert.rejects(() => sb.evaluate(`return fetch('http://127.0.0.1:${port}/redirect')`), /redirect/);
  });

  it('allowedHosts wraps a custom fetch too', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: ['api.example.com'] } });
    await sb.evaluate("await fetch('https://api.example.com/ok')");
    await assert.rejects(() => sb.evaluate("return fetch('https://other.example.com/')"), /not in the allowlist/);
    assert.deepEqual(seen.map((s) => s.url), ['https://api.example.com/ok']);
  });
});

describe('#39 network: option validation', () => {
  it('is refused for modes that cannot install it', () => {
    assert.throws(() => createSandbox({ mode: 'wasm', network: { fetch: () => {} } }), /mode: 'wasm'.*host\.call/);
    assert.throws(() => createSandbox({ mode: 'inline', network: { fetch: () => {} } }), /not mode: 'inline'/);
    assert.throws(() => createSandbox({ mode: 'data-uri', network: { fetch: () => {} } }), /not mode: 'data-uri'/);
    assert.throws(() => createSandbox({ untrusted: true, network: { fetch: () => {} } }), /mode: 'wasm'/);
  });

  it('conflicts with a capability named fetch', async () => {
    await assert.rejects(
      () => createSandbox({ capabilities: { fetch: () => {} }, network: { fetch: () => {} } }),
      /pass your function as network\.fetch/,
    );
  });

  it('rejects malformed options instead of ignoring them', () => {
    assert.throws(() => createFetchCapability(true), /network must be an object/);
    assert.throws(() => createFetchCapability({}), /needs `fetch`/);
    assert.throws(() => createFetchCapability({ fetch: 'x' }), /must be a function/);
    assert.throws(() => createFetchCapability({ allowedHosts: [] }), /at least one host/);
    assert.throws(() => createFetchCapability({ allowedHosts: [1] }), /hostname strings/);
    assert.throws(() => createFetchCapability({ fetch() {}, credentials: 'always' }), /credentials must be one of/);
    assert.throws(() => createFetchCapability({ fetch() {}, allowHosts: ['x'] }), /network\.allowHosts is not a known option/);
  });
});

describe('#39 createFetchCapability: the host side treats requests as untrusted input', () => {
  const cap = createFetchCapability({ fetch: () => new Response('ok') });

  it('validates method, headers, body and redirect', async () => {
    await assert.rejects(() => cap('https://x.example/', { method: 'GET /evil' }), /invalid method/);
    await assert.rejects(() => cap('https://x.example/', { headers: { a: 'b' } }), /pairs/);
    await assert.rejects(() => cap('https://x.example/', { headers: [['a', 1]] }), /pairs/);
    await assert.rejects(() => cap('https://x.example/', { method: 'POST', body: { a: 1 } }), /body must be a string/);
    await assert.rejects(() => cap('https://x.example/', { method: 'POST', body: 'a', bodyBase64: 'YQ==' }), /exclusive/);
    await assert.rejects(() => cap('https://x.example/', { redirect: 'sideways' }), /redirect/);
    await assert.rejects(() => cap('https://x.example/', 'GET'), /init must be an object/);
  });

  it('rejects responses the sandbox could not rebuild', async () => {
    const bad = (res) => createFetchCapability({ fetch: () => res })('https://x.example/');
    await assert.rejects(() => bad(undefined), /must return a Response/);
    await assert.rejects(() => bad({ status: 0 }), /status 0/);
    await assert.rejects(() => bad(Response.error()), /'error' response/);
    await assert.rejects(() => bad({ body: 42 }), /returned body must be/);
  });

  it('accepts a plain-object reply (the shape miso\'s host fetch returns)', async () => {
    const reply = await createFetchCapability({
      fetch: () => ({ status: 200, statusText: 'OK', headers: { 'x-a': '1' }, body: new Uint8Array([1, 2]), url: 'https://x.example/f' }),
    })('https://x.example/');
    assert.deepEqual({ ...reply, body: [...new Uint8Array(reply.body)] }, {
      status: 200, statusText: 'OK', headers: [['x-a', '1']], body: [1, 2], url: 'https://x.example/f', redirected: false,
    });
  });
});
