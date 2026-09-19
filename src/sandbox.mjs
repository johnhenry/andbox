/**
 * andbox — Sandboxed JavaScript runtime.
 *
 * Creates an isolated Web Worker sandbox with:
 * - RPC-based capability calls (host.call)
 * - Import map resolution
 * - Virtual module definitions
 * - Timeout + hard kill + restart
 * - Console forwarding
 * - Capability gating with rate limits
 */

import { makeWorkerSource } from './worker-source.mjs';
import { gateCapabilities } from './capability-gate.mjs';
import { makeDeferred, makeTimeoutError, makeAbortError } from './deferred.mjs';
import { DEFAULT_TIMEOUT_MS } from './constants.mjs';

const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;

// ── Inline sandbox (same-thread, AsyncFunction-based) ──

function createInlineSandbox(opts = {}) {
  const globals = opts.globals || {};
  return {
    async execute(code, execOpts = {}) {
      const timeout = execOpts.timeout || opts.defaultTimeoutMs || 30000;
      const globalKeys = Object.keys(globals);
      const globalValues = globalKeys.map(k => globals[k]);
      const output = [];
      const print = (...args) => {
        output.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
      };
      const fn = new AsyncFunction(...globalKeys, 'print', `"use strict";\n${code}`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await Promise.race([
          fn(...globalValues, print),
          new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () =>
              reject(new Error('Execution timed out')));
          }),
        ]);
        return { success: true, output: output.join('\n'), returnValue: result };
      } catch (e) {
        return { success: false, output: output.join('\n'), error: e.message || String(e) };
      } finally {
        clearTimeout(timer);
      }
    },
    terminate() {},
  };
}

// ── Data-URI sandbox (dynamic import-based isolation) ──

function createDataUriSandbox(opts = {}) {
  const globals = opts.globals || {};
  return {
    async execute(code, execOpts = {}) {
      const timeout = execOpts.timeout || opts.defaultTimeoutMs || 30000;
      const output = [];
      const globalEntries = Object.entries(globals);
      const preamble = globalEntries.length > 0
        ? `const { ${globalEntries.map(([k]) => k).join(', ')} } = globalThis.__andbox_globals__;\n`
        : '';
      const wrappedCode = `
const __globals__ = globalThis.__andbox_globals__;
const print = globalThis.__andbox_print__;
delete globalThis.__andbox_globals__;
delete globalThis.__andbox_print__;
${preamble}${code}`;
      const blob = new Blob([wrappedCode], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const print = (...args) => {
        output.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '));
      };
      globalThis.__andbox_globals__ = globals;
      globalThis.__andbox_print__ = print;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const result = await Promise.race([
          import(url),
          new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () =>
              reject(new Error('Execution timed out')));
          }),
        ]);
        return { success: true, output: output.join('\n'), returnValue: result?.default };
      } catch (e) {
        return { success: false, output: output.join('\n'), error: e.message || String(e) };
      } finally {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
        delete globalThis.__andbox_globals__;
        delete globalThis.__andbox_print__;
      }
    },
    terminate() {},
  };
}

// ── Service-Worker sandbox (path→content hosting, real URL/navigation semantics) ──

const CONTENT_TYPE_BY_EXTENSION = {
  html: 'text/html;charset=utf-8',
  css: 'text/css;charset=utf-8',
  js: 'text/javascript;charset=utf-8',
  mjs: 'text/javascript;charset=utf-8',
  json: 'application/json;charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain;charset=utf-8',
};

function guessContentType(path) {
  const ext = path.split('.').pop();
  return CONTENT_TYPE_BY_EXTENSION[ext] || 'application/octet-stream';
}

function normalizeServedEntry(path, value, defaults = {}) {
  if (typeof value === 'string') {
    return {
      body: value,
      contentType: defaults.contentType || guessContentType(path),
      status: defaults.status || 200,
      headers: defaults.headers || {},
    };
  }
  return {
    body: value.body,
    contentType: value.contentType || defaults.contentType || guessContentType(path),
    status: value.status || defaults.status || 200,
    headers: value.headers || defaults.headers || {},
  };
}

function normalizeServedFileMap(map) {
  const out = {};
  for (const [path, value] of Object.entries(map)) {
    out[path] = normalizeServedEntry(path, value);
  }
  return out;
}

/**
 * Resolve once the registration's worker has activated (or already has).
 * Rejects if the worker instead reaches `'redundant'` (its install/activate
 * threw, failed to parse, or was superseded before activating) -- without
 * this check the returned promise would otherwise hang forever, since
 * `'redundant'` is a valid terminal state `statechange` fires for that
 * is neither `'activated'` nor another `statechange` event to wait on.
 * Also bounded by `timeoutMs` as defense in depth for any lifecycle path
 * that reaches neither terminal state.
 */
export function waitForActive(registration, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (registration.active) return Promise.resolve();
  const worker = registration.installing || registration.waiting;
  if (!worker) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', onChange);
      reject(makeTimeoutError(timeoutMs));
    }, timeoutMs);
    function onChange() {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        worker.removeEventListener('statechange', onChange);
        resolve();
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        worker.removeEventListener('statechange', onChange);
        reject(new Error(
          "Service Worker registration became 'redundant' before activating -- " +
          'its install/activate handler likely threw, or it failed to parse. ' +
          'Check the browser console for the actual Service Worker error.'
        ));
      }
    }
    worker.addEventListener('statechange', onChange);
  });
}

/**
 * @typedef {Object} ServiceWorkerSandboxOptions
 * @property {string} scriptURL - Real same-origin http(s) URL serving makeServiceWorkerSource()'s output. A blob: URL is not accepted by the platform for Service Worker registration.
 * @property {string} [scope] - Scope to register the Service Worker under. Defaults to scriptURL's own directory.
 * @property {Record<string, string | { body: string, contentType?: string, status?: number, headers?: Record<string,string> }>} [files] - Initial path→content map.
 * @property {import('./virtual-module-registry.mjs').VirtualModuleRegistry} [registry] - A #13 virtual module registry to pull additional served content from, reusing its path/blob bookkeeping instead of a second one.
 * @property {number} [timeoutMs] - Max time to wait for the registration to activate before rejecting. Defaults to DEFAULT_TIMEOUT_MS.
 */

/**
 * Register a Service Worker that backs a path→content map with real
 * HTTP-shaped fetch/navigation semantics -- see andbox#14.
 *
 * Requires `navigator.serviceWorker` (a real browser). The generated
 * script (`makeServiceWorkerSource()`) cannot be registered from a
 * `blob:` URL -- the caller must already be serving it at a real
 * same-origin `scriptURL`.
 *
 * @param {ServiceWorkerSandboxOptions} [options]
 */
async function createServiceWorkerSandbox(options = {}) {
  const { scriptURL, scope, files = {}, registry, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  if (!scriptURL) {
    throw new Error(
      "createSandbox({ mode: 'service-worker' }) requires a scriptURL: the real " +
      "same-origin http(s) URL where you are already serving makeServiceWorkerSource()'s " +
      'output. Service Worker registration requires a real http(s) scriptURL -- unlike ' +
      "worker/data-uri mode, a blob: URL is not accepted by the platform. See andbox#14."
    );
  }
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) {
    throw new Error(
      "mode: 'service-worker' requires navigator.serviceWorker (a real browser); " +
      'it is not available under Node. See andbox#14.'
    );
  }

  let disposed = false;

  // Build the initial served-file map. Reuse a #13 virtual module registry's
  // own path/blob bookkeeping when given one, rather than a second table:
  // pull each of its known paths' real content straight from its blob URLs.
  const initialFiles = { ...files };
  if (registry) {
    for (const path of registry.paths()) {
      const url = registry.resolve(path);
      const res = await fetch(url);
      initialFiles[path] = { body: await res.text(), contentType: guessContentType(path) };
    }
  }

  const registration = await navigator.serviceWorker.register(
    scriptURL,
    scope ? { scope } : undefined
  );

  // Only resolve once this registration is active. This -- combined with
  // the documented contract "don't navigate anything into scope until this
  // promise resolves" -- is what actually avoids the first-navigation race
  // described in andbox#14 and in makeServiceWorkerSource()'s doc comment:
  // clients.claim() (called in the generated script's activate handler)
  // only takes over clients that are *already open*; it doesn't retroactively
  // intercept a navigation into scope that started before activation.
  await waitForActive(registration, timeoutMs);

  async function send(message) {
    if (disposed) throw new Error('Sandbox is disposed');
    const target = registration.active;
    if (!target) throw new Error('Service Worker is not active');
    const { promise, resolve } = makeDeferred();
    const channel = new MessageChannel();
    channel.port1.onmessage = ({ data }) => resolve(data);
    target.postMessage(message, [channel.port2]);
    return promise;
  }

  await send({ type: 'configure', files: normalizeServedFileMap(initialFiles) });

  /**
   * Register (or replace) one served file.
   * @param {string} path
   * @param {string} source
   * @param {{ contentType?: string, status?: number, headers?: Record<string,string> }} [entryOpts]
   */
  async function define(path, source, entryOpts = {}) {
    const entry = normalizeServedEntry(path, source, entryOpts);
    await send({ type: 'define', path, entry });
  }

  /** Remove a served file; requests for it fall through to the network. */
  async function remove(path) {
    await send({ type: 'remove', path });
  }

  /** Unregister the Service Worker. */
  async function dispose() {
    if (disposed) return;
    disposed = true;
    await registration.unregister();
  }

  return {
    scriptURL,
    scope: registration.scope,
    define,
    remove,
    dispose,
    isDisposed: () => disposed,
  };
}

/**
 * @typedef {Object} SandboxOptions
 * @property {{ imports?: Record<string,string>, scopes?: Record<string,Record<string,string>> }} [importMap]
 * @property {Record<string, Function>} [capabilities] - Host functions callable via host.call()
 * @property {number} [defaultTimeoutMs] - Default timeout for evaluate()
 * @property {string} [baseURL] - Base URL for relative imports
 * @property {import('./capability-gate.mjs').GatePolicy} [policy] - Rate limiting policy
 * @property {(level: string, ...args: string[]) => void} [onConsole] - Console output handler
 */

/**
 * Create a new sandboxed runtime.
 *
 * @param {SandboxOptions | ServiceWorkerSandboxOptions} [options]
 * @returns {{ execute: Function, terminate: Function } | Promise<{ evaluate: Function, defineModule: Function, dispose: Function, isDisposed: () => boolean }> | Promise<{ scriptURL: string, scope: string, define: Function, remove: Function, dispose: Function, isDisposed: () => boolean }>}
 */
export function createSandbox(options = {}) {
  const mode = options.mode || 'worker';
  if (mode === 'inline') return createInlineSandbox(options);
  if (mode === 'data-uri') return createDataUriSandbox(options);
  if (mode === 'service-worker') return createServiceWorkerSandbox(options);
  return createWorkerSandbox(options);
}

async function createWorkerSandbox(options = {}) {
  const {
    importMap = { imports: {}, scopes: {} },
    capabilities = {},
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    baseURL = typeof location !== 'undefined' ? location.href : 'https://andbox.local/',
    policy,
    onConsole,
  } = options;

  // Gate capabilities with rate limits
  const { gated: gatedCaps, stats: gateStats } = gateCapabilities(capabilities, policy);

  // Console handler — mutable so evaluate() can swap per-call
  let activeConsoleHandler = onConsole || null;

  // Track virtual modules for re-creation on restart
  const virtualModules = new Map();
  let disposed = false;
  let worker = null;
  let workerBlobURL = null;

  // Pending evaluations
  const pending = new Map(); // id -> { resolve, reject, timer }

  // ── Worker lifecycle ──

  function createWorker() {
    const source = makeWorkerSource();
    const blob = new Blob([source], { type: 'application/javascript' });
    workerBlobURL = URL.createObjectURL(blob);
    worker = new Worker(workerBlobURL, { type: 'classic' });

    worker.onmessage = ({ data: msg }) => {
      switch (msg.type) {
        case 'configured':
        case 'moduleDefined':
          // Handled by configure/defineModule promises below
          break;

        case 'result': {
          const entry = pending.get(msg.id);
          if (entry) {
            pending.delete(msg.id);
            if (entry.timer) clearTimeout(entry.timer);
            if (msg.success) {
              entry.resolve(msg.value);
            } else {
              const err = new Error(msg.error?.message || 'Evaluation failed');
              err.name = msg.error?.name || 'Error';
              entry.reject(err);
            }
          }
          break;
        }

        case 'capabilityCall': {
          handleCapabilityCall(msg.id, msg.name, msg.args);
          break;
        }

        case 'console': {
          if (activeConsoleHandler) {
            activeConsoleHandler(msg.level, ...msg.args);
          }
          break;
        }
      }
    };

    worker.onerror = (e) => {
      // Reject all pending on Worker error
      for (const [id, entry] of pending) {
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error(`Worker error: ${e.message}`));
      }
    };
  }

  async function configureWorker() {
    const { promise, resolve } = makeDeferred();
    const handler = ({ data }) => {
      if (data.type === 'configured') {
        worker.removeEventListener('message', handler);
        resolve();
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'configure',
      importMap,
      baseURL,
      virtualModules: Object.fromEntries(virtualModules),
    });
    await promise;
  }

  async function handleCapabilityCall(rpcId, name, args) {
    const fn = gatedCaps[name];
    if (!fn) {
      worker.postMessage({
        type: 'capabilityResult',
        id: rpcId,
        success: false,
        error: `Unknown capability: ${name}`,
      });
      return;
    }
    try {
      const value = await fn(...args);
      worker.postMessage({ type: 'capabilityResult', id: rpcId, success: true, value });
    } catch (e) {
      worker.postMessage({
        type: 'capabilityResult',
        id: rpcId,
        success: false,
        error: e.message || String(e),
      });
    }
  }

  function terminateWorker() {
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (workerBlobURL) {
      URL.revokeObjectURL(workerBlobURL);
      workerBlobURL = null;
    }
  }

  async function restartWorker() {
    terminateWorker();
    createWorker();
    await configureWorker();
  }

  // ── Public API ──

  /**
   * Evaluate JavaScript code in the sandbox.
   *
   * @param {string} code - JavaScript code to execute (wrapped in async IIFE).
   * @param {{ timeoutMs?: number, signal?: AbortSignal, onConsole?: (level: string, ...args: string[]) => void }} [opts]
   * @returns {Promise<any>} The return value of the code.
   */
  async function evaluate(code, opts = {}) {
    if (disposed) throw new Error('Sandbox is disposed');
    if (!worker) await restartWorker();

    // Random (not sequential) id so code running during one evaluate() call
    // can't guess the id of a concurrent evaluate() on the same worker and
    // forge a matching message to interfere with it.
    const id = crypto.randomUUID();
    const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs;
    const { promise, resolve, reject } = makeDeferred();

    // Swap console handler for this evaluation if provided
    const prevConsoleHandler = activeConsoleHandler;
    if (opts.onConsole) {
      activeConsoleHandler = opts.onConsole;
    }

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pending.delete(id);
        reject(makeTimeoutError(timeoutMs));
        // Hard kill and restart — only reliable way to stop infinite loops
        restartWorker().catch(() => {});
      }, timeoutMs);
    }

    // AbortSignal support
    if (opts.signal) {
      if (opts.signal.aborted) {
        if (timer) clearTimeout(timer);
        throw makeAbortError();
      }
      opts.signal.addEventListener('abort', () => {
        const entry = pending.get(id);
        if (entry) {
          pending.delete(id);
          if (entry.timer) clearTimeout(entry.timer);
          entry.reject(makeAbortError());
          restartWorker().catch(() => {});
        }
      }, { once: true });
    }

    pending.set(id, { resolve, reject, timer });
    worker.postMessage({ type: 'evaluate', id, code });

    // Restore console handler when evaluation completes
    if (opts.onConsole) {
      return promise.finally(() => { activeConsoleHandler = prevConsoleHandler; });
    }
    return promise;
  }

  /**
   * Define a virtual module accessible via sandboxImport().
   *
   * @param {string} name - Module specifier (e.g. 'std/hello').
   * @param {string} source - Module source code.
   */
  async function defineModule(name, source) {
    if (disposed) throw new Error('Sandbox is disposed');

    virtualModules.set(name, source);

    if (worker) {
      const { promise, resolve } = makeDeferred();
      const handler = ({ data }) => {
        if (data.type === 'moduleDefined' && data.name === name) {
          worker.removeEventListener('message', handler);
          resolve();
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'defineModule', name, source });
      await promise;
    }
  }

  /**
   * Terminate the sandbox. Rejects all pending evaluations.
   */
  async function dispose() {
    if (disposed) return;
    disposed = true;

    // Reject all pending
    for (const [id, entry] of pending) {
      pending.delete(id);
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(new Error('Sandbox disposed'));
    }

    terminateWorker();
  }

  /**
   * Get sandbox stats (gate stats, pending count, etc.).
   */
  function stats() {
    return {
      disposed,
      pendingEvaluations: pending.size,
      virtualModules: [...virtualModules.keys()],
      gate: gateStats(),
    };
  }

  // ── Initialize ──
  createWorker();
  await configureWorker();

  return {
    evaluate,
    defineModule,
    dispose,
    stats,
    isDisposed: () => disposed,
  };
}
