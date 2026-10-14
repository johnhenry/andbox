/**
 * `mode: 'iframe'` -- the host side.
 *
 * Each "worker" is a `<iframe sandbox="allow-scripts" srcdoc="...">`: an
 * opaque origin with its own realm, `window` and `document`. The srcdoc holds
 * a small bootstrap plus the same runtime script Worker mode uses (without
 * the Worker-global lockdown). The host talks to it over a MessageChannel
 * whose second port is transferred to the frame after a token-checked
 * handshake; after that nothing travels over `window.postMessage`.
 *
 * `createIframeFactory()` returns a `workerFactory`-compatible function whose
 * result is Worker-shaped (`postMessage`, `onmessage`, `onerror`,
 * `add/removeEventListener('message')`, `terminate()`, `dead`), so the rest of
 * the sandbox (RPC, timeouts, restarts, capability abort) is shared with
 * Worker mode unchanged.
 */

import { randomId } from './random-id.mjs';
import { makeRuntimeSource } from './worker-source.mjs';

/** The sandbox token andbox always sets; the frame cannot run code without it. */
const BASE_TOKEN = 'allow-scripts';

/** Inline style for the default, evaluation-only placement (no `container`). */
const OFFSCREEN_STYLE =
  'position:absolute;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';

/** Attributes andbox owns on the frame; never copied onto a replacement frame. */
const OWNED_ATTRIBUTES = new Set(['srcdoc', 'src', 'sandbox']);

/** Attributes of the wrapper element that are copied onto the sandboxed frame inside it. */
const DELEGATED_ATTRIBUTES = ['allow', 'allowfullscreen', 'title'];

/**
 * The runtime script the frame runs: Worker mode's, minus the global lockdown.
 * @param {{ networkFetch?: boolean, bridges?: boolean }} [options]  `networkFetch`: replace the
 *   frame's `fetch` with the host-backed one (`createSandbox({ network })`);
 *   `bridges`: include the bridge client (`createSandbox({ bridges })`).
 */
export function makeIframeRuntimeSource({ networkFetch = false, bridges = false } = {}) {
  return makeRuntimeSource({ lockdown: false, networkFetch, bridges });
}

/**
 * Make text safe to place inside an inline `<script>` element. `</script` would
 * end the element early and `<!--` can switch the tokenizer into the
 * "script data escaped" state; both only occur inside string literals here.
 */
function escapeInlineScript(text) {
  return text.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
}

function escapeAttribute(text) {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Build the frame's `srcdoc`.
 *
 * Order matters: the bootstrap runs first, then the optional CSP `<meta>`
 * (a meta policy applies to what comes after it, so the bootstrap is never
 * blocked by it, while `eval`/`new Function`, imports, fetches and any
 * scripts in `html` are), then the caller's `html` in `<body>`.
 *
 * `nested`: the frame sits inside andbox's `frameSrc` wrapper, so the host
 * page is `parent.parent`; the handshake is with that window.
 *
 * @param {{ source: string, token: string, csp?: string, html?: string, nested?: boolean }} parts
 * @returns {string}
 */
export function makeIframeDocument({ source, token, csp, html = '', nested = false }) {
  const bootstrap = `
(function () {
  'use strict';
  var TOKEN = ${JSON.stringify(token)};
  var parentWindow = ${nested ? 'window.parent.parent' : 'window.parent'};
  var started = false;
  function onInit(e) {
    if (started || e.source !== parentWindow) return;
    var d = e.data;
    if (!d || d.type !== 'andbox:init' || d.token !== TOKEN || !e.ports || !e.ports[0]) return;
    started = true;
    window.removeEventListener('message', onInit);
    var port = e.ports[0];
    var send = port.postMessage.bind(port);
    // No pagehide/unload listener here on purpose: in Chromium one blocks fast
    // shutdown of the frame's process, so a frame stuck in a busy loop would
    // keep its (shared) process hung for seconds after the host removed it.
    // The host detects navigation from the element's load events instead.
    var portScope = {
      postMessage: send,
      close: function () { port.close(); },
      set onmessage(fn) { port.onmessage = fn; },
    };
    (function (self) {
${escapeInlineScript(source)}
    })(portScope);
  }
  window.addEventListener('message', onInit);
  function hello() { parentWindow.postMessage({ type: 'andbox:hello', token: TOKEN }, '*'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hello, { once: true });
  else hello();
})();
`;
  const cspMeta = csp ? `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}">` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><script>${bootstrap}</script>${cspMeta}</head><body>${html}</body></html>`;
}

/**
 * The `frame-src` source list for `frameSrc`: `'none'` for an empty list.
 * @param {string[]} frameSrc  validated by normalizeIframeOptions()
 */
export function frameSrcPolicy(frameSrc) {
  return `frame-src ${frameSrc.length ? frameSrc.join(' ') : "'none'"}`;
}

/**
 * Build the `frameSrc` wrapper's `srcdoc`: an empty document whose only
 * policy is `frame-src`. Nothing else goes in it: the sandboxed frame is a
 * srcdoc frame and inherits this document's policies, so a `script-src` or
 * `default-src` here would block andbox's own bootstrap in it. (`frame-src`
 * does not apply to the `about:srcdoc` frame itself, only to where frames in
 * this document navigate.) The wrapper runs no script; the host builds the
 * sandboxed frame in it through the DOM.
 *
 * @param {string[]} frameSrc
 * @returns {string}
 */
export function makeWrapperDocument(frameSrc) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(frameSrcPolicy(frameSrc))}"></head><body></body></html>`;
}

/**
 * Validate `frameSrc`: CSP source expressions such as `'example.com'`,
 * `'https://cdn.example.com'`, `'*.example.com'`, `'https:'` or `"'self'"`.
 * Anything that could end the directive or the policy (`;`, `,`, whitespace)
 * or add another keyword is refused rather than passed through.
 *
 * @returns {string[] | null}
 */
function normalizeFrameSrc(frameSrc) {
  if (frameSrc === undefined || frameSrc === null) return null;
  if (!Array.isArray(frameSrc) || !frameSrc.every((h) => typeof h === 'string')) {
    throw new TypeError("frameSrc must be an array of hosts (CSP source expressions), e.g. ['https://example.com']");
  }
  const out = [];
  for (const raw of frameSrc) {
    const s = raw.trim();
    const keyword = s.toLowerCase() === "'self'";
    if (!keyword && !/^[^\s;,'"]+$/.test(s)) {
      throw new TypeError(`frameSrc: '${raw}' is not a host or CSP source expression`);
    }
    const v = keyword ? "'self'" : s;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Validate the iframe-only options. Throws on anything that would silently
 * weaken the boundary.
 *
 * @returns {{ tokens: string[], allowSameOrigin: boolean, csp: string | undefined, html: string, container: Element | null, onFrame: ((f: HTMLIFrameElement) => void) | null, frameSrc: string[] | null }}
 */
export function normalizeIframeOptions(options = {}) {
  const {
    iframeSandbox = [],
    dangerouslyAllowSameOrigin = false,
    csp,
    html = '',
    container = null,
    onFrame = null,
    frameSrc,
  } = options;

  if (!Array.isArray(iframeSandbox) || !iframeSandbox.every((t) => typeof t === 'string')) {
    throw new TypeError("iframeSandbox must be an array of sandbox token strings, e.g. ['allow-forms']");
  }
  const tokens = [BASE_TOKEN];
  for (const raw of iframeSandbox) {
    const t = raw.trim().toLowerCase();
    if (!/^allow-[a-z-]+$/.test(t)) {
      throw new TypeError(`iframeSandbox: '${raw}' is not a sandbox token (expected 'allow-...')`);
    }
    if (!tokens.includes(t)) tokens.push(t);
  }
  const allowSameOrigin = tokens.includes('allow-same-origin');
  if (allowSameOrigin && dangerouslyAllowSameOrigin !== true) {
    throw new Error(
      "iframeSandbox: 'allow-same-origin' together with 'allow-scripts' (always set in mode: 'iframe') lets the " +
      'framed code reach your page, its cookies and storage, and remove its own sandbox attribute -- there is no ' +
      'boundary left. Pass dangerouslyAllowSameOrigin: true only if the code is fully trusted.'
    );
  }
  if (csp !== undefined && typeof csp !== 'string') throw new TypeError('csp must be a Content-Security-Policy string');
  if (typeof html !== 'string') throw new TypeError('html must be a string of body markup');
  if (onFrame !== null && typeof onFrame !== 'function') throw new TypeError('onFrame must be a function');
  if (container !== null && (typeof container !== 'object' || typeof container.appendChild !== 'function')) {
    throw new TypeError('container must be a DOM element');
  }
  return { tokens, allowSameOrigin, csp: csp || undefined, html, container, onFrame, frameSrc: normalizeFrameSrc(frameSrc) };
}

/**
 * Create the iframe "worker" factory for one sandbox.
 *
 * @param {ReturnType<typeof normalizeIframeOptions>} opts
 * @param {number} startupTimeoutMs  how long to wait for a new frame's handshake
 * @returns {{ factory: (source: string) => object, current: () => HTMLIFrameElement | null, currentWindow: () => Window | null }}
 */
export function createIframeFactory(opts, startupTimeoutMs) {
  const win = globalThis;
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== 'function' || typeof win.addEventListener !== 'function') {
    throw new Error(
      "mode: 'iframe' needs a DOM (a browser page with `document`); it is not available under Node or inside a Worker."
    );
  }
  const nested = opts.frameSrc !== null;
  // Where the last frame was, so a restart puts its replacement in the same
  // spot with the same attributes (class, style, width, ...).
  let slot = null;
  let current = null;

  function factory(source) {
    const token = randomId() + randomId();
    // `frame` is the element in the page (placement, attributes, onFrame,
    // sandbox.iframe). Without frameSrc it is also the sandboxed frame; with
    // it, it is the wrapper and the sandboxed frame (`inner`) is made inside
    // it once the wrapper has loaded.
    const frame = doc.createElement('iframe');
    if (slot) {
      for (const [name, value] of slot.attributes) frame.setAttribute(name, value);
    } else {
      if (!opts.container) {
        frame.setAttribute('style', OFFSCREEN_STYLE);
        frame.setAttribute('aria-hidden', 'true');
        frame.setAttribute('tabindex', '-1');
      }
      frame.setAttribute('title', 'andbox sandbox');
    }
    const sandboxed = { frame: nested ? null : frame };
    const srcdoc = makeIframeDocument({ source, token, csp: opts.csp, html: opts.html, nested });
    if (nested) {
      frame.srcdoc = makeWrapperDocument(opts.frameSrc);
    } else {
      frame.setAttribute('sandbox', opts.tokens.join(' '));
      frame.srcdoc = srcdoc;
    }

    const channel = new MessageChannel();
    const port = channel.port1;
    const listeners = new Set();
    const expectedOrigin = opts.allowSameOrigin ? win.location?.origin : 'null';
    let terminated = false;
    let startTimer = null;

    const adapter = {
      iframe: frame,
      get window() { return sandboxed.frame?.contentWindow ?? null; },
      dead: false,
      onmessage: null,
      onerror: null,
      // Messages posted before the handshake wait in the port's queue and
      // travel with the transferred port, like messages to a starting Worker.
      postMessage(message) {
        if (!terminated) port.postMessage(message);
      },
      addEventListener(type, fn) {
        if (type === 'message') listeners.add(fn);
      },
      removeEventListener(type, fn) {
        if (type === 'message') listeners.delete(fn);
      },
      terminate() {
        if (terminated) return;
        terminated = true;
        adapter.dead = true;
        cleanupHandshake();
        try { port.close(); } catch {}
        slot = {
          parent: frame.parentNode,
          next: frame.nextSibling,
          attributes: [...frame.attributes]
            .filter((a) => !OWNED_ATTRIBUTES.has(a.name))
            .map((a) => [a.name, a.value]),
        };
        // Removing the wrapper removes the sandboxed frame inside it too.
        frame.remove();
        if (current === adapter) current = null;
      },
    };

    function fail(message) {
      if (terminated || adapter.dead) return;
      adapter.dead = true;
      cleanupHandshake();
      adapter.onerror?.({ message });
    }

    port.onmessage = (event) => {
      if (terminated) return;
      adapter.onmessage?.(event);
      for (const fn of [...listeners]) fn(event);
    };

    // Bind the handshake to this frame's own WindowProxy and its secret token.
    // `event.origin` is checked too, but on its own it would prove nothing:
    // every opaque-origin frame reports 'null'.
    function onHello(event) {
      const target = sandboxed.frame;
      if (terminated || !target || event.source === null || event.source !== target.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== 'andbox:hello' || data.token !== token) return;
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      cleanupHandshake();
      target.contentWindow.postMessage({ type: 'andbox:init', token }, '*', [channel.port2]);
    }

    function cleanupHandshake() {
      win.removeEventListener('message', onHello);
      if (startTimer !== null) { clearTimeout(startTimer); startTimer = null; }
    }

    // The element's first load event is the srcdoc document; any later one
    // means a different document now lives in the frame (the code navigated
    // or reloaded it, or the element was moved in the DOM), and the runtime
    // that held our port is gone.
    const UNLOADED = 'Sandbox iframe unloaded (it navigated, was reloaded, or was moved in the DOM)';
    function watchLoads(el, onFirst) {
      let loads = 0;
      el.addEventListener('load', () => {
        if (++loads > 1) fail(UNLOADED);
        else onFirst?.();
      });
    }

    // frameSrc: the wrapper has loaded (same origin, no script of its own);
    // build the sandboxed frame in it. The wrapper document takes the
    // element's color-scheme, so the sandboxed document's backdrop is painted
    // as it would be without the wrapper.
    function buildInner() {
      if (terminated || adapter.dead) return;
      let wdoc;
      try { wdoc = frame.contentDocument; } catch { wdoc = null; }
      if (!wdoc?.body) {
        fail('Sandbox iframe wrapper (frameSrc) did not load as a same-origin document');
        return;
      }
      const scheme = win.getComputedStyle?.(frame)?.colorScheme;
      if (scheme) wdoc.documentElement.style.colorScheme = scheme;
      wdoc.documentElement.style.height = '100%';
      Object.assign(wdoc.body.style, { margin: '0', height: '100%', overflow: 'hidden' });
      const inner = wdoc.createElement('iframe');
      for (const name of DELEGATED_ATTRIBUTES) {
        if (frame.hasAttribute(name)) inner.setAttribute(name, frame.getAttribute(name));
      }
      Object.assign(inner.style, { display: 'block', width: '100%', height: '100%', border: '0' });
      inner.setAttribute('sandbox', opts.tokens.join(' '));
      inner.srcdoc = srcdoc;
      watchLoads(inner);
      sandboxed.frame = inner;
      wdoc.body.appendChild(inner);
    }

    watchLoads(frame, nested ? buildInner : null);

    win.addEventListener('message', onHello);
    if (startupTimeoutMs > 0) {
      startTimer = setTimeout(() => {
        startTimer = null;
        fail(
          `Sandbox iframe did not start within ${startupTimeoutMs}ms ` +
          '(is its container attached to a document, and does csp/html leave its bootstrap intact?)'
        );
      }, startupTimeoutMs);
    }

    try {
      opts.onFrame?.(frame);
      if (!frame.isConnected) {
        const prev = slot;
        if (prev?.parent?.isConnected) {
          prev.parent.insertBefore(frame, prev.next && prev.next.parentNode === prev.parent ? prev.next : null);
        } else {
          (opts.container || doc.body || doc.documentElement).appendChild(frame);
        }
      }
    } catch (e) {
      adapter.terminate();
      throw e;
    }
    slot = null;
    current = adapter;
    return adapter;
  }

  return {
    factory,
    current: () => current?.iframe ?? null,
    currentWindow: () => current?.window ?? null,
  };
}
