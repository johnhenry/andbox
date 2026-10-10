/**
 * mode: 'iframe' -- the parts that run under Node: option validation, the
 * srcdoc the frame is built from, and the refusal to run without a DOM.
 * The behaviour in a real browser (evaluate, host.call, timeouts, the opaque
 * origin, ...) is covered by test/browser/iframe-mode.spec.mjs in Chromium,
 * Firefox and WebKit (`npm run test:browser`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, makeWorkerSource } from '../src/index.mjs';
import { normalizeIframeOptions, makeIframeDocument, makeIframeRuntimeSource } from '../src/iframe-host.mjs';

describe("mode: 'iframe' under Node", () => {
  it('rejects with a clear error: there is no DOM', async () => {
    await assert.rejects(() => createSandbox({ mode: 'iframe' }), /mode: 'iframe' needs a DOM/);
  });

  it('rejects workerFactory and nodeWorker, which cannot apply', async () => {
    await assert.rejects(() => createSandbox({ mode: 'iframe', workerFactory: () => ({}) }), /do not apply to mode: 'iframe'/);
    await assert.rejects(() => createSandbox({ mode: 'iframe', nodeWorker: { permissions: true } }), /do not apply/);
  });

  it('is not what untrusted: true selects', () => {
    assert.throws(() => createSandbox({ untrusted: true, mode: 'iframe' }), /untrusted.*wasm/);
  });
});

describe('normalizeIframeOptions', () => {
  it('always sets allow-scripts and appends extra tokens once, normalised', () => {
    const { tokens } = normalizeIframeOptions({ iframeSandbox: ['allow-forms', ' ALLOW-POPUPS ', 'allow-forms', 'allow-scripts'] });
    assert.deepEqual(tokens, ['allow-scripts', 'allow-forms', 'allow-popups']);
  });

  it('refuses allow-same-origin (with allow-scripts it removes the boundary) unless explicitly opted in', () => {
    assert.throws(() => normalizeIframeOptions({ iframeSandbox: ['allow-same-origin'] }), /dangerouslyAllowSameOrigin/);
    assert.throws(() => normalizeIframeOptions({ iframeSandbox: ['allow-same-origin'], dangerouslyAllowSameOrigin: 'yes' }), /dangerouslyAllowSameOrigin/);
    const opts = normalizeIframeOptions({ iframeSandbox: ['allow-same-origin'], dangerouslyAllowSameOrigin: true });
    assert.ok(opts.tokens.includes('allow-same-origin'));
    assert.equal(opts.allowSameOrigin, true);
  });

  it('createSandbox() rejects allow-same-origin before anything else', async () => {
    await assert.rejects(() => createSandbox({ mode: 'iframe', iframeSandbox: ['allow-same-origin'] }), /allow-same-origin/);
  });

  it('rejects malformed tokens and option types', () => {
    assert.throws(() => normalizeIframeOptions({ iframeSandbox: 'allow-forms' }), TypeError);
    assert.throws(() => normalizeIframeOptions({ iframeSandbox: ['allow-forms allow-popups'] }), /not a sandbox token/);
    assert.throws(() => normalizeIframeOptions({ iframeSandbox: ['forms'] }), /not a sandbox token/);
    assert.throws(() => normalizeIframeOptions({ csp: 42 }), /csp/);
    assert.throws(() => normalizeIframeOptions({ html: {} }), /html/);
    assert.throws(() => normalizeIframeOptions({ onFrame: 'x' }), /onFrame/);
    assert.throws(() => normalizeIframeOptions({ container: 'body' }), /container/);
  });
});

describe('makeIframeDocument', () => {
  const source = makeIframeRuntimeSource();

  it('runs the bootstrap before the CSP meta, and the caller html in <body>', () => {
    const doc = makeIframeDocument({ source, token: 't0k', csp: "default-src 'none'", html: '<p id="x">hi</p>' });
    const script = doc.indexOf('<script>');
    const meta = doc.indexOf('<meta http-equiv="Content-Security-Policy"');
    const body = doc.indexOf('<body><p id="x">hi</p></body>');
    assert.ok(script > -1 && meta > script && body > meta, 'order: bootstrap, CSP meta, body');
    assert.match(doc, /content="default-src 'none'"/);
  });

  it('escapes the CSP attribute value', () => {
    const doc = makeIframeDocument({ source, token: 't', csp: `a "b" <c> & d` });
    assert.match(doc, /content="a &quot;b&quot; &lt;c> &amp; d"/);
  });

  it('omits the CSP meta when no csp is given', () => {
    assert.doesNotMatch(makeIframeDocument({ source, token: 't' }), /Content-Security-Policy/);
  });

  it('cannot be broken out of by </script> or <!-- inside the runtime source', () => {
    const doc = makeIframeDocument({ source: 'const s = "</script><b>x</b>"; const c = "<!--";', token: 't' });
    const inner = doc.slice(doc.indexOf('<script>') + 8, doc.lastIndexOf('</script>'));
    assert.doesNotMatch(inner, /<\/script/i);
    assert.doesNotMatch(inner, /<!--/);
    assert.match(inner, /<\\\/script>/);
  });

  it('binds the handshake to the parent window and the token', () => {
    const doc = makeIframeDocument({ source, token: 'abc-123' });
    assert.match(doc, /var TOKEN = "abc-123";/);
    assert.match(doc, /e\.source !== parentWindow/);
    assert.match(doc, /d\.token !== TOKEN/);
  });

  it('registers no pagehide/unload listener (it would stall Chromium process shutdown after a kill)', () => {
    const doc = makeIframeDocument({ source, token: 't' });
    assert.doesNotMatch(doc, /addEventListener\(['"](pagehide|unload|beforeunload)/);
  });
});

describe('runtime source', () => {
  it('the iframe runtime keeps window/fetch (no Worker-global lockdown); worker mode keeps its lockdown', () => {
    const iframe = makeIframeRuntimeSource();
    assert.match(iframe, /const LOCKED_GLOBALS = \[\];/);
    assert.match(iframe, /const SHADOWED = \[\];/);
    const worker = makeWorkerSource();
    assert.match(worker, /const LOCKED_GLOBALS = \[\s*'fetch'/);
    assert.match(worker, /const SHADOWED = \[\.\.\.LOCKED_GLOBALS, 'window'\];/);
  });
});
