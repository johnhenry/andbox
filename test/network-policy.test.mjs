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
