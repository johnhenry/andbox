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

import { makeRuntimeSource } from './worker-source.mjs';

/** The sandbox token andbox always sets; the frame cannot run code without it. */
const BASE_TOKEN = 'allow-scripts';

/** Inline style for the default, evaluation-only placement (no `container`). */
const OFFSCREEN_STYLE =
  'position:absolute;left:-10000px;top:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';

/** Attributes andbox owns on the frame; never copied onto a replacement frame. */
const OWNED_ATTRIBUTES = new Set(['srcdoc', 'src', 'sandbox']);

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
 * @param {{ source: string, token: string, csp?: string, html?: string }} parts
 * @returns {string}
 */
export function makeIframeDocument({ source, token, csp, html = '' }) {
  const bootstrap = `
(function () {
  'use strict';
  var TOKEN = ${JSON.stringify(token)};
  var parentWindow = window.parent;
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
 * Validate the iframe-only options. Throws on anything that would silently
 * weaken the boundary.
 *
 * @returns {{ tokens: string[], allowSameOrigin: boolean, csp: string | undefined, html: string, container: Element | null, onFrame: ((f: HTMLIFrameElement) => void) | null }}
 */
export function normalizeIframeOptions(options = {}) {
  const {
    iframeSandbox = [],
    dangerouslyAllowSameOrigin = false,
    csp,
    html = '',
    container = null,
    onFrame = null,
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
  return { tokens, allowSameOrigin, csp: csp || undefined, html, container, onFrame };
}

/**
 * Create the iframe "worker" factory for one sandbox.
 *
 * @param {ReturnType<typeof normalizeIframeOptions>} opts
 * @param {number} startupTimeoutMs  how long to wait for a new frame's handshake
 * @returns {{ factory: (source: string) => object, current: () => HTMLIFrameElement | null }}
 */
export function createIframeFactory(opts, startupTimeoutMs) {
  const win = globalThis;
  const doc = globalThis.document;
  if (!doc || typeof doc.createElement !== 'function' || typeof win.addEventListener !== 'function') {
    throw new Error(
      "mode: 'iframe' needs a DOM (a browser page with `document`); it is not available under Node or inside a Worker."
    );
  }
  // Where the last frame was, so a restart puts its replacement in the same
  // spot with the same attributes (class, style, width, ...).
  let slot = null;
  let current = null;

  function factory(source) {
    const token = crypto.randomUUID() + crypto.randomUUID();
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
    frame.setAttribute('sandbox', opts.tokens.join(' '));
    frame.srcdoc = makeIframeDocument({ source, token, csp: opts.csp, html: opts.html });

    const channel = new MessageChannel();
    const port = channel.port1;
    const listeners = new Set();
    const expectedOrigin = opts.allowSameOrigin ? win.location?.origin : 'null';
    let terminated = false;
    let startTimer = null;

    const adapter = {
      iframe: frame,
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
      if (terminated || event.source === null || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.type !== 'andbox:hello' || data.token !== token) return;
      if (expectedOrigin && event.origin !== expectedOrigin) return;
      cleanupHandshake();
      frame.contentWindow.postMessage({ type: 'andbox:init', token }, '*', [channel.port2]);
    }

    function cleanupHandshake() {
      win.removeEventListener('message', onHello);
      if (startTimer !== null) { clearTimeout(startTimer); startTimer = null; }
    }

    // The element's first load event is the srcdoc document; any later one
    // means a different document now lives in the frame (the code navigated
    // or reloaded it, or the element was moved in the DOM), and the runtime
    // that held our port is gone.
    let loads = 0;
    frame.addEventListener('load', () => {
      if (++loads > 1) fail('Sandbox iframe unloaded (it navigated, was reloaded, or was moved in the DOM)');
    });

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
  };
}
