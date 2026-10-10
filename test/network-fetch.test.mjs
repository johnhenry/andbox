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
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
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
    const sb = await make({ network: { allowedHosts: '*', fetch: recorder().hostFetch } });
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
      network: { allowedHosts: '*',
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
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
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
    const sb = await make({ baseURL: 'https://app.example.com/notebook/', network: { allowedHosts: '*', fetch: hostFetch } });
    await sb.evaluate("await fetch('data.json'); await fetch('/api/v1')");
    assert.deepEqual(seen.map((s) => s.url), ['https://app.example.com/notebook/data.json', 'https://app.example.com/api/v1']);
  });

  it('null-body statuses and a host Response both work', async () => {
    const sb = await make({ network: { allowedHosts: '*', fetch: () => new Response(null, { status: 204 }) } });
    assert.deepEqual(await sb.evaluate("const r = await fetch('https://x.example/'); return [r.status, await r.text()]"), [204, '']);
  });

  it('the shim is reinstalled in the fresh worker after a timeout kill', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
    await assert.rejects(() => sb.evaluate('while (true) {}', { timeoutMs: 100 }), /timed out/i);
    assert.deepEqual(await sb.evaluate("return (await fetch('https://x.example/a')).json()"), { url: 'https://x.example/a' });
    assert.equal(seen.length, 1);
  });
});

describe('#39 network: what the sandbox cannot do', () => {
  it('non-http(s) URLs are refused in the sandbox, and the host function is never called', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
    for (const url of ['data:text/plain,hi', 'file:///etc/passwd', 'blob:https://x.example/1', 'javascript:1', 'ftp://x.example/']) {
      const r = await sb.evaluate(`try { await fetch(${JSON.stringify(url)}); return 'fetched'; } catch (e) { return e.name + ': ' + e.message; }`);
      assert.match(r, /^TypeError: fetch: only http\(s\) URLs are allowed/, url);
    }
    assert.equal(seen.length, 0);
  });

  it('non-http(s) URLs are refused by the host too, when the capability is called directly', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'file:///etc/passwd', {})"), /only http\(s\) URLs are allowed/);
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'not a url', {})"), /invalid URL/);
    await assert.rejects(() => sb.evaluate("return host.call('fetch', ['https://x.example/'], {})"), /must be a string/);
    assert.equal(seen.length, 0);
  });

  it('credentials cannot be forced from inside: init, a Request, or a direct host.call', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch } });
    await sb.evaluate(`
      await fetch('https://x.example/1', { credentials: 'include' });
      await fetch(new Request('https://x.example/2', { credentials: 'include' }));
      await host.call('fetch', 'https://x.example/3', { method: 'GET', headers: [], credentials: 'include' });
    `);
    assert.deepEqual(seen.map((s) => s.credentials), ['omit', 'omit', 'omit']);
  });

  it('the host decides credentials (network.credentials)', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch, credentials: 'same-origin' } });
    await sb.evaluate("await fetch('https://x.example/', { credentials: 'omit' })");
    assert.equal(seen[0].credentials, 'same-origin');
  });

  it('Set-Cookie never reaches the sandbox', async () => {
    const sb = await make({
      network: { allowedHosts: '*', fetch: () => new Response('x', { headers: { 'set-cookie': 'sid=secret', 'x-ok': '1' } }) },
    });
    const r = await sb.evaluate("const r = await fetch('https://x.example/'); return [r.headers.get('set-cookie'), r.headers.get('x-ok')]");
    assert.deepEqual(r, [null, '1']);
  });

  it('host errors surface as a TypeError, like a failed fetch', async () => {
    const sb = await make({ network: { allowedHosts: '*', fetch: () => { throw new Error('blocked by policy'); } } });
    const r = await sb.evaluate("try { await fetch('https://x.example/'); } catch (e) { return [e.name, e.message]; }");
    assert.deepEqual(r, ['TypeError', 'fetch failed: blocked by policy']);
  });

  it('an AbortSignal rejects the sandbox fetch with AbortError', async () => {
    const sb = await make({ network: { allowedHosts: '*', fetch: () => new Promise(() => {}) } });
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
    const sb = await make({ network: { allowedHosts: '*', fetch: hostFetch }, policy: { capabilities: { fetch: { maxCalls: 2, maxArgBytes: 2000 } } } });
    await sb.evaluate("await fetch('https://x.example/1'); await fetch('https://x.example/2')");
    const r = await sb.evaluate("try { await fetch('https://x.example/3') } catch (e) { return e.message }");
    assert.match(r, /Capability 'fetch' call limit exceeded/);
    assert.equal(seen.length, 2);
    assert.equal(sb.stats().gate.perCapability.fetch.calls, 2);
  });

  it('binary request bodies count toward the gate\'s argument-size limit', async () => {
    const sb = await make({ network: { allowedHosts: '*', fetch: recorder().hostFetch }, policy: { capabilities: { fetch: { maxArgBytes: 1000 } } } });
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
    assert.throws(() => createSandbox({ mode: 'wasm', network: { allowedHosts: '*', fetch: () => {} } }), /mode: 'wasm'.*host\.call/);
    assert.throws(() => createSandbox({ mode: 'inline', network: { allowedHosts: '*', fetch: () => {} } }), /not mode: 'inline'/);
    assert.throws(() => createSandbox({ mode: 'data-uri', network: { allowedHosts: '*', fetch: () => {} } }), /not mode: 'data-uri'/);
    assert.throws(() => createSandbox({ untrusted: true, network: { allowedHosts: '*', fetch: () => {} } }), /mode: 'wasm'/);
  });

  it('conflicts with a capability named fetch', async () => {
    await assert.rejects(
      () => createSandbox({ capabilities: { fetch: () => {} }, network: { allowedHosts: '*', fetch: () => {} } }),
      /pass your function as network\.fetch/,
    );
  });

  it('rejects malformed options instead of ignoring them', () => {
    assert.throws(() => createFetchCapability(true), /network must be an object/);
    assert.throws(() => createFetchCapability({ allowedHosts: '*', fetch: 'x' }), /must be a function/);
    assert.throws(() => createFetchCapability({ allowedHosts: '*', fetch() {}, credentials: 'always' }), /credentials must be one of/);
    assert.throws(() => createFetchCapability({ allowedHosts: '*', fetch() {}, allowHosts: ['x'] }), /network\.allowHosts is not a known option/);
  });
});

describe('#43 network.allowedHosts is required: no network unless you say which hosts', () => {
  it('network without allowedHosts throws at createSandbox, naming the option and showing the forms', () => {
    let calls = 0;
    const hostFetch = () => { calls++; return new Response('x'); };
    for (const mode of ['worker', 'node-worker', 'iframe']) {
      assert.throws(() => createSandbox({ mode, network: { fetch: hostFetch } }), (err) => {
        assert.match(err.message, /network\.allowedHosts is required/);
        assert.match(err.message, /allowedHosts: \['api\.example\.com'\]/);
        assert.match(err.message, /allowedHosts: \(url\) =>/);
        assert.match(err.message, /allowedHosts: '\*'/);
        return true;
      }, mode);
    }
    assert.throws(() => createSandbox({ network: {} }), /network\.allowedHosts is required/);
    assert.throws(() => createSandbox({ network: { credentials: 'omit' } }), /network\.allowedHosts is required/);
    assert.throws(() => createFetchCapability({ fetch: hostFetch }), /network\.allowedHosts is required/);
    assert.equal(calls, 0);
  });

  it('an empty list and other shapes are refused', () => {
    assert.throws(() => createSandbox({ network: { allowedHosts: [] } }), /at least one host; to give the sandbox no network, omit `network`/);
    for (const bad of [null, true, 'api.example.com', '**', 'any', {}, new Set(['a.example'])]) {
      assert.throws(() => createFetchCapability({ allowedHosts: bad }), /must be an array of hostnames, a function \(url: URL\) => boolean, or '\*'/, String(bad));
    }
  });

  it('array entries that could never match are refused, not silently ignored', () => {
    assert.throws(() => createFetchCapability({ allowedHosts: ['*'] }), /pass the string '\*' itself, not inside an array/);
    for (const bad of ['', 1, 'https://api.example.com', 'api.example.com:8080', 'api.example.com/v1', '*.example.com',
      '::1', 'user@api.example.com', 'api example.com', '[::1]:8080']) {
      assert.throws(() => createFetchCapability({ allowedHosts: ['ok.example', bad] }), /entries are hostnames|not a valid hostname/, String(bad));
    }
  });
});

describe('#43 allowedHosts: an array of hostnames', () => {
  it('matches the exact hostname, case-insensitively, on any port and scheme; not subdomains or parents', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: ['API.Example.com', '127.0.0.1', '[::1]', 'bücher.example'] } });
    const allowed = [
      'https://api.example.com/a', 'http://api.example.com:8080/b', 'https://API.EXAMPLE.COM/c',
      'http://127.0.0.1:3000/d', 'http://[::1]:3000/e', 'https://bücher.example/f',
    ];
    for (const url of allowed) await sb.evaluate(`await fetch(${JSON.stringify(url)})`);
    for (const url of ['https://x.api.example.com/', 'https://example.com/', 'https://api.example.com.evil.example/', 'http://localhost/']) {
      await assert.rejects(() => sb.evaluate(`return fetch(${JSON.stringify(url)})`), /is not in the allowlist/, url);
    }
    assert.deepEqual(seen.map((s) => s.url), [
      'https://api.example.com/a', 'http://api.example.com:8080/b', 'https://api.example.com/c',
      'http://127.0.0.1:3000/d', 'http://[::1]:3000/e', 'https://xn--bcher-kva.example/f',
    ]);
  });
});

/** A host fetch that answers from a route table and records each request it was asked to make. */
function router(routes) {
  const seen = [];
  function hostFetch(url, init) {
    seen.push({
      url,
      method: init.method,
      headers: Object.fromEntries(init.headers),
      body: init.body === undefined ? undefined : String(init.body),
      redirect: init.redirect,
    });
    const route = routes[url];
    if (route) return route(url, init);
    return Response.json({ url, method: init.method });
  }
  return { seen, hostFetch };
}
const redirect = (status, location) => () => new Response(null, { status, headers: { location } });

describe('#43 allowedHosts: a function, asked on the host for every request', () => {
  it('is asked with a URL before the host fetch runs, and re-evaluated per request (a dynamic allowlist)', async () => {
    const { seen, hostFetch } = recorder();
    const allowed = new Set(['a.example']);
    const asked = [];
    const sb = await make({
      network: {
        fetch: hostFetch,
        allowedHosts: (url) => {
          asked.push([url instanceof URL, url.href]);
          return allowed.has(url.hostname);
        },
      },
    });
    await sb.evaluate("await fetch('https://a.example/1')");
    await assert.rejects(() => sb.evaluate("return fetch('https://b.example/1')"), /b\.example is not allowed by network\.allowedHosts/);
    allowed.add('b.example'); // e.g. the user said yes to a prompt
    await sb.evaluate("await fetch('https://b.example/2')");
    allowed.delete('a.example');
    await assert.rejects(() => sb.evaluate("return fetch('https://a.example/3')"), /a\.example is not allowed/);
    assert.deepEqual(seen.map((s) => s.url), ['https://a.example/1', 'https://b.example/2']);
    assert.deepEqual(asked, [
      [true, 'https://a.example/1'], [true, 'https://b.example/1'], [true, 'https://b.example/2'], [true, 'https://a.example/3'],
    ]);
  });

  it('may be async; only `true` allows; a thrown error is what the sandbox sees', async () => {
    const answers = { 'yes.example': true, 'one.example': 1, 'str.example': 'yes' };
    const sb = await make({
      network: {
        fetch: recorder().hostFetch,
        allowedHosts: async (url) => {
          await new Promise((r) => setTimeout(r, 1));
          if (url.hostname === 'ask.example') throw new Error('ask.example needs your permission first');
          return answers[url.hostname];
        },
      },
    });
    assert.deepEqual(await sb.evaluate("return (await fetch('https://yes.example/')).json()"), { url: 'https://yes.example/' });
    for (const host of ['one.example', 'str.example', 'no.example']) {
      await assert.rejects(() => sb.evaluate(`return fetch('https://${host}/')`), /is not allowed by network\.allowedHosts/, host);
    }
    const r = await sb.evaluate("try { await fetch('https://ask.example/') } catch (e) { return [e.name, e.message] }");
    assert.deepEqual(r, ['TypeError', 'fetch failed: ask.example needs your permission first']);
  });

  it('cannot change the URL that is requested by mutating its argument', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({
      network: { fetch: hostFetch, allowedHosts: (url) => { url.hostname = 'evil.example'; return true; } },
    });
    await sb.evaluate("await fetch('https://good.example/x')");
    assert.deepEqual(seen.map((s) => s.url), ['https://good.example/x']);
  });

  it('a direct host.call goes through it too', async () => {
    const { seen, hostFetch } = recorder();
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: () => false } });
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'https://x.example/', { headers: [] })"), /not allowed/);
    assert.equal(seen.length, 0);
  });
});

describe('#43 allowedHosts function: redirects are followed by andbox, asking the function about every hop', () => {
  it('each hop is requested with redirect: manual and checked; the sandbox sees the final URL and redirected', async () => {
    const { seen, hostFetch } = router({
      'https://a.example/start': redirect(302, '/middle'),
      'https://a.example/middle': redirect(301, 'https://b.example/end?q=1'),
    });
    const asked = [];
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: (url) => { asked.push(url.href); return true; } } });
    const r = await sb.evaluate("const res = await fetch('https://a.example/start'); return [res.status, res.url, res.redirected, await res.json()]");
    assert.deepEqual(r, [200, 'https://b.example/end?q=1', true, { url: 'https://b.example/end?q=1', method: 'GET' }]);
    assert.deepEqual(asked, ['https://a.example/start', 'https://a.example/middle', 'https://b.example/end?q=1']);
    assert.deepEqual(seen.map((s) => [s.url, s.redirect]), [
      ['https://a.example/start', 'manual'], ['https://a.example/middle', 'manual'], ['https://b.example/end?q=1', 'manual'],
    ]);
  });

  it('a hop the function refuses is never requested', async () => {
    const { seen, hostFetch } = router({ 'https://a.example/out': redirect(302, 'http://169.254.169.254/latest/meta-data/') });
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: (url) => url.hostname === 'a.example' } });
    await assert.rejects(() => sb.evaluate("return fetch('https://a.example/out')"), /169\.254\.169\.254 is not allowed by network\.allowedHosts/);
    assert.deepEqual(seen.map((s) => s.url), ['https://a.example/out']);
  });

  it('rewrites the method and body like the Fetch standard, and drops Authorization on a cross-origin hop', async () => {
    const { seen, hostFetch } = router({
      'https://a.example/303': redirect(303, '/end'),
      'https://a.example/302': redirect(302, '/end'),
      'https://a.example/307': redirect(307, '/end'),
      'https://a.example/cross': redirect(308, 'https://b.example/end'),
    });
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: () => true } });
    await sb.evaluate(`
      const init = { method: 'POST', body: 'payload', headers: { 'content-type': 'text/plain', authorization: 'Bearer t', 'x-keep': '1' } };
      await fetch('https://a.example/303', init);
      await fetch('https://a.example/302', init);
      await fetch('https://a.example/307', init);
      await fetch('https://a.example/cross', init);
      await fetch('https://a.example/303', { ...init, method: 'HEAD', body: undefined });
    `);
    const hops = seen.filter((s) => s.url.endsWith('/end'));
    const view = (s) => [s.method, s.body, s.headers['content-type'] ?? null, s.headers.authorization ?? null, s.headers['x-keep']];
    assert.deepEqual(hops.map(view), [
      ['GET', undefined, null, 'Bearer t', '1'], // 303: GET, body dropped
      ['GET', undefined, null, 'Bearer t', '1'], // 302 after POST: GET
      ['POST', 'payload', 'text/plain', 'Bearer t', '1'], // 307: unchanged
      ['POST', 'payload', 'text/plain', null, '1'], // 308 to another origin: Authorization dropped
      ['HEAD', undefined, 'text/plain', 'Bearer t', '1'], // 303 keeps HEAD (and its headers)
    ]);
  });

  it("honours the sandbox's redirect mode: 'error' rejects, 'manual' returns the redirect unfollowed", async () => {
    const { seen, hostFetch } = router({ 'https://a.example/r': redirect(302, 'https://a.example/end') });
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: () => true } });
    await assert.rejects(() => sb.evaluate("return fetch('https://a.example/r', { redirect: 'error' })"), /redirect mode is 'error'/);
    const r = await sb.evaluate("const res = await fetch('https://a.example/r', { redirect: 'manual' }); return [res.status, res.headers.get('location')]");
    assert.deepEqual(r, [302, 'https://a.example/end']);
    assert.deepEqual(seen.map((s) => s.url), ['https://a.example/r', 'https://a.example/r']);
  });

  it('refuses a redirect loop after 20 hops, a non-http(s) target, and an opaque redirect it cannot read', async () => {
    const { seen, hostFetch } = router({
      'https://a.example/loop': redirect(302, '/loop'),
      'https://a.example/file': redirect(302, 'file:///etc/passwd'),
      'https://a.example/opaque': () => ({ type: 'opaqueredirect', status: 0, headers: [] }),
    });
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: () => true } });
    await assert.rejects(() => sb.evaluate("return fetch('https://a.example/loop')"), /more than 20 redirects/);
    assert.equal(seen.length, 21);
    await assert.rejects(() => sb.evaluate("return fetch('https://a.example/file')"), /redirected to a file: URL/);
    await assert.rejects(() => sb.evaluate("return fetch('https://a.example/opaque')"), /hides, so network\.allowedHosts cannot check it/);
  });
});

describe("#43 allowedHosts: '*', any http(s) host; the host fetch is the whole policy", () => {
  it("passes every http(s) request and the sandbox's redirect mode to the host fetch unchanged", async () => {
    const { seen, hostFetch } = router({});
    const sb = await make({ network: { fetch: hostFetch, allowedHosts: '*' } });
    await sb.evaluate("await fetch('https://anything.example/'); await fetch('http://10.0.0.1/', { redirect: 'error' })");
    assert.deepEqual(seen.map((s) => [s.url, s.redirect]), [['https://anything.example/', 'follow'], ['http://10.0.0.1/', 'error']]);
    await assert.rejects(() => sb.evaluate("return host.call('fetch', 'file:///etc/passwd', {})"), /only http\(s\) URLs/);
  });
});

describe('#43 allowedHosts against a real server', () => {
  let server;
  let port;
  const hits = [];
  before(async () => {
    server = http.createServer((req, res) => {
      hits.push(`${req.headers.host}${req.url}`);
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://localhost:${port}/data` }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(() => new Promise((r) => server.close(r)));

  it('a function over the platform fetch follows a redirect it allows and stops before one it refuses', async () => {
    const both = await make({ network: { allowedHosts: (url) => ['127.0.0.1', 'localhost'].includes(url.hostname) } });
    const r = await both.evaluate(`const res = await fetch('http://127.0.0.1:${port}/redirect'); return [res.url, res.redirected, await res.json()]`);
    assert.deepEqual(r, [`http://localhost:${port}/data`, true, { path: '/data' }]);
    hits.length = 0;
    const one = await make({ network: { allowedHosts: (url) => url.hostname === '127.0.0.1' } });
    await assert.rejects(() => one.evaluate(`return fetch('http://127.0.0.1:${port}/redirect')`), new RegExp(`localhost:${port} is not allowed`));
    assert.deepEqual(hits, [`127.0.0.1:${port}/redirect`], 'the refused hop was never requested');
  });

  it("'*' without a fetch uses the platform fetch, which follows redirects anywhere", async () => {
    const sb = await make({ network: { allowedHosts: '*' } });
    const r = await sb.evaluate(`const res = await fetch('http://127.0.0.1:${port}/redirect'); return [res.redirected, await res.json()]`);
    assert.deepEqual(r, [true, { path: '/data' }]);
  });
});

describe('#39 createFetchCapability: the host side treats requests as untrusted input', () => {
  const cap = createFetchCapability({ allowedHosts: '*', fetch: () => new Response('ok') });

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
    const bad = (res) => createFetchCapability({ allowedHosts: '*', fetch: () => res })('https://x.example/');
    await assert.rejects(() => bad(undefined), /must return a Response/);
    await assert.rejects(() => bad({ status: 0 }), /status 0/);
    await assert.rejects(() => bad(Response.error()), /'error' response/);
    await assert.rejects(() => bad({ body: 42 }), /returned body must be/);
  });

  it('accepts a plain-object reply (the shape miso\'s host fetch returns)', async () => {
    const reply = await createFetchCapability({
      allowedHosts: '*',
      fetch: () => ({ status: 200, statusText: 'OK', headers: { 'x-a': '1' }, body: new Uint8Array([1, 2]), url: 'https://x.example/f' }),
    })('https://x.example/');
    assert.deepEqual({ ...reply, body: [...new Uint8Array(reply.body)] }, {
      status: 200, statusText: 'OK', headers: [['x-a', '1']], body: [1, 2], url: 'https://x.example/f', redirected: false,
    });
  });
});
