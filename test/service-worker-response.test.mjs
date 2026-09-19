/**
 * Real behavioral tests for the service-worker mode's pure request-matching
 * / response-synthesis logic.
 *
 * Node has no ServiceWorkerGlobalScope at all (confirmed: `typeof self`,
 * `typeof ServiceWorkerGlobalScope`, and `navigator.serviceWorker` are all
 * unavailable), so a real SW registration can't be tested here -- that's
 * why this logic was factored out of the generated SW script into its own
 * pure module in the first place (see the doc comment at the top of
 * src/service-worker-response.mjs). `Response`/`Headers` themselves *are*
 * real Node globals, so every assertion below inspects an actual Response.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeScopePath,
  matchFile,
  makeResponseForFile,
  resolveServiceWorkerResponse,
} from '../src/service-worker-response.mjs';

describe('normalizeScopePath', () => {
  it('adds a leading slash if missing', () => {
    assert.equal(normalizeScopePath('foo.js'), '/foo.js');
  });

  it('leaves an already-leading-slash path alone', () => {
    assert.equal(normalizeScopePath('/foo.js'), '/foo.js');
  });
});

describe('matchFile', () => {
  it('finds a direct match in a Map', () => {
    const files = new Map([['/foo.js', { body: 'x' }]]);
    assert.deepEqual(matchFile('/foo.js', files), { body: 'x' });
  });

  it('finds a direct match in a plain object', () => {
    const files = { '/foo.js': { body: 'x' } };
    assert.deepEqual(matchFile('/foo.js', files), { body: 'x' });
  });

  it('returns null for a path with no match and no directory index', () => {
    const files = new Map([['/foo.js', { body: 'x' }]]);
    assert.equal(matchFile('/missing.js', files), null);
  });

  it('falls back to index.html for a trailing-slash directory path', () => {
    const files = new Map([['/blog/index.html', { body: '<h1>blog</h1>' }]]);
    assert.deepEqual(matchFile('/blog/', files), { body: '<h1>blog</h1>' });
  });

  it('falls back to index.html for a directory path with no trailing slash', () => {
    const files = new Map([['/blog/index.html', { body: '<h1>blog</h1>' }]]);
    assert.deepEqual(matchFile('/blog', files), { body: '<h1>blog</h1>' });
  });

  it('does not apply the directory-index fallback when a real match exists', () => {
    const files = new Map([
      ['/blog', { body: 'direct file, not a directory' }],
      ['/blog/index.html', { body: 'should not be used' }],
    ]);
    assert.deepEqual(matchFile('/blog', files), { body: 'direct file, not a directory' });
  });
});

describe('makeResponseForFile', () => {
  it('returns null for a null entry (caller should fall through to network)', () => {
    assert.equal(makeResponseForFile(null), null);
  });

  it('synthesizes a real Response with the entry body, status, and content-type', async () => {
    const res = makeResponseForFile({ body: 'hello', contentType: 'text/plain', status: 201 });
    assert.ok(res instanceof Response);
    assert.equal(res.status, 201);
    assert.equal(res.headers.get('content-type'), 'text/plain');
    assert.equal(await res.text(), 'hello');
  });

  it('defaults status to 200 and content-type to application/octet-stream', async () => {
    const res = makeResponseForFile({ body: 'x' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  });

  it('respects an explicit content-type header over the contentType field', async () => {
    const res = makeResponseForFile({
      body: '{}',
      contentType: 'text/plain',
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.headers.get('content-type'), 'application/json');
  });

  it('carries through arbitrary extra headers', () => {
    const res = makeResponseForFile({ body: 'x', headers: { 'x-andbox': 'served' } });
    assert.equal(res.headers.get('x-andbox'), 'served');
  });
});

describe('resolveServiceWorkerResponse', () => {
  it('end-to-end: produces the exact Response the SW fetch handler would return', async () => {
    const files = new Map([
      ['/index.html', { body: '<h1>home</h1>', contentType: 'text/html' }],
      ['/style.css', { body: 'body{color:red}', contentType: 'text/css' }],
    ]);

    const home = resolveServiceWorkerResponse('/index.html', files);
    assert.equal(home.headers.get('content-type'), 'text/html');
    assert.equal(await home.text(), '<h1>home</h1>');

    const style = resolveServiceWorkerResponse('style.css', files); // no leading slash
    assert.equal(await style.text(), 'body{color:red}');
  });

  it('returns null for an unknown path so the caller falls through to the network', () => {
    const files = new Map([['/index.html', { body: 'x' }]]);
    assert.equal(resolveServiceWorkerResponse('/not-here.js', files), null);
  });
});
