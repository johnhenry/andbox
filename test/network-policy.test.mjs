import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createNetworkFetch } from '../src/network-policy.mjs';

describe('createNetworkFetch', () => {
  it('allows requests to allowlisted hosts', async () => {
    const mockFetch = async (url) => new Response('ok', { status: 200 });
    const gatedFetch = createNetworkFetch(['allowed.example.com'], mockFetch);
    const res = await gatedFetch('https://allowed.example.com/data');
    assert.equal(res.status, 200);
  });

  it('denies requests to non-allowlisted hosts', async () => {
    const mockFetch = async (url) => new Response('ok', { status: 200 });
    const gatedFetch = createNetworkFetch(['allowed.example.com'], mockFetch);
    await assert.rejects(
      () => gatedFetch('https://evil.example.com/data'),
      /not in the allowlist/
    );
  });

  it('rejects a redirect from an allowlisted host to a non-allowlisted host', async () => {
    // Simulates realFetch() honoring redirect: 'manual' and returning the
    // 3xx response itself, rather than following it -- the way undici/Node
    // and modern browsers behave when redirect: 'manual' is passed.
    const mockFetch = async (url, init) => {
      assert.equal(init.redirect, 'manual', 'must request redirect: manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://evil.example.com/steal' },
      });
    };
    const gatedFetch = createNetworkFetch(['allowed.example.com'], mockFetch);
    await assert.rejects(
      () => gatedFetch('https://allowed.example.com/redirect-me'),
      /redirect/i
    );
  });

  it('rejects an opaqueredirect-style response (browser redirect: manual semantics)', async () => {
    const mockFetch = async () => {
      // Browsers surface redirect: 'manual' responses with type
      // 'opaqueredirect', headers inaccessible. (Response() rejects status 0
      // in Node, so we stub status 200 and only override `type` here --
      // the policy only inspects `type` for this case.)
      const res = new Response(null, { status: 200 });
      Object.defineProperty(res, 'type', { value: 'opaqueredirect' });
      return res;
    };
    const gatedFetch = createNetworkFetch(['allowed.example.com'], mockFetch);
    await assert.rejects(
      () => gatedFetch('https://allowed.example.com/redirect-me'),
      /redirect/i
    );
  });

  it('passes through all hosts when no allowlist is configured (no redirect enforcement)', async () => {
    const mockFetch = async () => new Response('ok', { status: 200 });
    const gatedFetch = createNetworkFetch(null, mockFetch);
    const res = await gatedFetch('https://anywhere.example.com/data');
    assert.equal(res.status, 200);
  });

  it('rejects invalid URLs', async () => {
    const mockFetch = async () => new Response('ok');
    const gatedFetch = createNetworkFetch(['allowed.example.com'], mockFetch);
    await assert.rejects(() => gatedFetch('not a url'), /Invalid URL/);
  });
});

// #6 with real sockets: a real redirecting server, a real second server that
// must never be contacted, and the real global fetch.
import http from 'node:http';
import { after, before } from 'node:test';

describe('createNetworkFetch — real redirecting server (#6)', () => {
  let front, back, frontPort, backPort, backHits = 0;
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

  before(async () => {
    back = http.createServer((req, res) => { backHits++; res.end('secret'); });
    backPort = await listen(back);
    front = http.createServer((req, res) => {
      if (req.url === '/ok') return res.end('fine');
      if (req.url === '/same') { res.writeHead(302, { Location: '/ok' }); return res.end(); }
      if (req.url === '/chain') { res.writeHead(307, { Location: '/same' }); return res.end(); }
      res.writeHead(302, { Location: `http://localhost:${backPort}/steal` });
      res.end();
    });
    frontPort = await listen(front);
  });
  after(() => { front.close(); back.close(); });

  it('does not follow a redirect to a non-allowlisted host and never contacts it', async () => {
    const gated = createNetworkFetch(['127.0.0.1']);
    await assert.rejects(() => gated(`http://127.0.0.1:${frontPort}/go`), /redirect/i);
    assert.equal(backHits, 0, 'the redirect target must never be contacted');
  });

  it('a caller-supplied redirect: "follow" cannot re-enable following', async () => {
    const gated = createNetworkFetch(['127.0.0.1']);
    await assert.rejects(() => gated(`http://127.0.0.1:${frontPort}/go`, { redirect: 'follow' }), /redirect/i);
    assert.equal(backHits, 0);
  });

  it('rejects every hop kind, including same-host and chained redirects', async () => {
    const gated = createNetworkFetch(['127.0.0.1']);
    await assert.rejects(() => gated(`http://127.0.0.1:${frontPort}/same`), /redirect/i);
    await assert.rejects(() => gated(`http://127.0.0.1:${frontPort}/chain`), /redirect/i);
  });

  it('still serves non-redirect responses', async () => {
    const gated = createNetworkFetch(['127.0.0.1']);
    const res = await gated(`http://127.0.0.1:${frontPort}/ok`);
    assert.equal(await res.text(), 'fine');
  });
});
