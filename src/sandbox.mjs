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
import { makeWasmWorkerSource } from './wasm-worker-source.mjs';
import { resolveWithImportMap } from './import-map-resolver.mjs';
import { gateCapabilities } from './capability-gate.mjs';
import { makeDeferred, makeTimeoutError, makeAbortError } from './deferred.mjs';
import { DEFAULT_TIMEOUT_MS } from './constants.mjs';
import { isNodeRuntime, createNodeWorkerFactory } from './node-worker.mjs';

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
        ? `const { ${globalEntries.map(([k]) => k).join(', ')} } = __globals__;\n`
        : '';
      const wrappedCode = `
const __globals__ = globalThis.__andbox_globals__;
const print = globalThis.__andbox_print__;
delete globalThis.__andbox_globals__;
delete globalThis.__andbox_print__;
${preamble}${code}`;
      // Node's ESM loader cannot import() a blob: URL; it can a data: URL.
      const nodeRuntime = isNodeRuntime();
      const url = nodeRuntime
        ? 'data:text/javascript;base64,' + Buffer.from(wrappedCode).toString('base64')
        : URL.createObjectURL(new Blob([wrappedCode], { type: 'text/javascript' }));
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
        if (!nodeRuntime) URL.revokeObjectURL(url);
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
      initialFiles[path] = { body: registry.source(path), contentType: guessContentType(path) };
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

const SUPPORTED_MODES = ['worker', 'node-worker', 'wasm', 'inline', 'data-uri', 'service-worker'];

/**
 * Create a new sandboxed runtime.
 *
 * @param {SandboxOptions | ServiceWorkerSandboxOptions} [options]
 * @returns {{ execute: Function, terminate: Function } | Promise<{ evaluate: Function, defineModule: Function, dispose: Function, isDisposed: () => boolean }> | Promise<{ scriptURL: string, scope: string, define: Function, remove: Function, dispose: Function, isDisposed: () => boolean }>}
 */
export function createSandbox(options = {}) {
  const mode = options.mode ?? 'worker';
  if (!SUPPORTED_MODES.includes(mode)) {
    throw new Error(
      `Unknown sandbox mode ${typeof mode === 'string' ? `'${mode}'` : String(mode)}. ` +
      `Supported modes: ${SUPPORTED_MODES.map((m) => `'${m}'`).join(', ')}.`
    );
  }
  if (mode === 'inline') return createInlineSandbox(options);
  if (mode === 'data-uri') return createDataUriSandbox(options);
  if (mode === 'service-worker') return createServiceWorkerSandbox(options);
  return createWorkerSandbox(options, mode === 'node-worker', mode === 'wasm');
}

/** Default limits for `mode: 'wasm'` (0 = unlimited / not enforced). */
const WASM_DEFAULTS = Object.freeze({
  fuel: 0,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 128 * 1024,
});

/**
 * Extra grace (ms) the host's hard-kill backstop waits beyond the in-worker
 * deadline, so a cooperative TimeoutError wins over terminate() + respawn.
 */
const WASM_BACKSTOP_GRACE_MS = 1000;

function checkLimit(name, value) {
  if (value === undefined) return;
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new Error(`${name} must be a non-negative number (0 disables it); got ${String(value)}`);
  }
}

/**
 * Work out where the Worker should load the engine and `.wasm` from, and
 * validate the limit options. Under Node the installed optional packages are
 * used when no URLs are given; in a browser the URLs (or import map entries
 * `@johnhenry/andbox/wasm-engine` / `@johnhenry/andbox/wasm`) are required.
 */
async function resolveWasmConfig(options, baseURL, usingNode) {
  const { engineURL, wasmURL, fuel, memoryBytes, stackBytes, deadlineMs, importMap } = options;
  checkLimit('fuel', fuel);
  checkLimit('memoryBytes', memoryBytes);
  checkLimit('stackBytes', stackBytes);
  checkLimit('deadlineMs', deadlineMs);

  const abs = (u) => (u == null ? null : new URL(u, baseURL).href);
  let engine = abs(engineURL ?? resolveWithImportMap('@johnhenry/andbox/wasm-engine', importMap));
  let wasm = abs(wasmURL ?? resolveWithImportMap('@johnhenry/andbox/wasm', importMap));

  if (!engine && (usingNode || isNodeRuntime())) {
    // Non-literal specifier: browser bundlers must not follow this Node-only file.
    const spec = './node-' + 'wasm.mjs';
    const { resolveNodeWasmEngine } = await import(/* @vite-ignore */ /* webpackIgnore: true */ spec);
    const found = resolveNodeWasmEngine();
    engine = found.engineURL;
    wasm = wasm ?? found.wasmURL;
  }
  if (!engine || !wasm) {
    throw new Error(
      "createSandbox({ mode: 'wasm' }) needs `engineURL` (an ES module built from " +
      "@johnhenry/andbox/src/wasm-engine.mjs) and `wasmURL` (the QuickJS .wasm file), both served " +
      'from your own origin. See the README section on mode: wasm for the two-command setup.'
    );
  }
  return {
    engine: { engineURL: engine, wasmURL: wasm },
    limits: {
      fuel: fuel ?? WASM_DEFAULTS.fuel,
      memoryBytes: memoryBytes ?? WASM_DEFAULTS.memoryBytes,
      stackBytes: stackBytes ?? WASM_DEFAULTS.stackBytes,
      deadlineMs, // undefined -> the per-evaluate timeout
    },
  };
}

async function createWorkerSandbox(options = {}, forceNode = false, isWasm = false) {
  const {
    importMap = { imports: {}, scopes: {} },
    capabilities = {},
    defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    baseURL = typeof location !== 'undefined' ? location.href : 'https://andbox.local/',
    policy,
    onConsole,
    nodeWorker,
    unref = false,
  } = options;

  // Node mode: no global Worker (and no blob: worker URLs) -> node:worker_threads.
  // An explicit workerFactory always wins; 'node-worker' forces Node; the
  // default selects it only when there is no global Worker under Node.
  let workerFactory = options.workerFactory || null;
  let usingNode = false;
  if (!workerFactory && (forceNode || (typeof Worker === 'undefined' && isNodeRuntime()))) {
    workerFactory = await createNodeWorkerFactory(nodeWorker);
    usingNode = true;
  }
  if (nodeWorker && !usingNode) {
    // A security option that silently does nothing is worse than an error.
    throw new Error(
      'The nodeWorker option only applies to the built-in Node worker_threads mode; ' +
      'it cannot be honoured with a browser Worker or a custom workerFactory.'
    );
  }

  // mode: 'wasm' -- resolve the engine location and limits up front so a
  // missing optional dependency fails here, with an install hint.
  let wasmConfig = null;
  if (isWasm) {
    if (nodeWorker?.permissions) {
      throw new Error(
        "nodeWorker.permissions is not supported with mode: 'wasm' yet: the Worker has to read the " +
        'engine and .wasm file from disk, which the permission model blocks. The WASM engine is the ' +
        'isolation layer in this mode; see the README threat model.'
      );
    }
    wasmConfig = await resolveWasmConfig(options, baseURL, usingNode);
  }

  // Gate capabilities with rate limits
  const { gated: gatedCaps, stats: gateStats } = gateCapabilities(capabilities, policy);

  // Console handler — mutable so evaluate() can swap per-call
  let activeConsoleHandler = onConsole || null;

  // Track virtual modules for re-creation on restart
  const virtualModules = new Map();
  let disposed = false;
  let worker = null;
  let workerBlobURL = null;

  // `unref`: the thread only keeps the host process alive while work is in
  // flight (startup, evaluate, defineModule); idle, it lets the process exit.
  let activeOps = 0;
  function beginOp() {
    activeOps++;
    worker?.ref?.();
  }
  function endOp() {
    if (--activeOps === 0 && unref) worker?.unref?.();
  }

  // Pending evaluations
  const pending = new Map(); // id -> { resolve, reject, timer }

  // mode: 'wasm' bookkeeping (stats() adds these)
  const wasmStats = { fuelUsed: 0, peakMemoryBytes: 0, totalFuelUsed: 0 };

  // ── Worker lifecycle ──

  function createWorker() {
    const source = isWasm ? makeWasmWorkerSource() : makeWorkerSource();
    if (workerFactory) {
      worker = workerFactory(source);
      attachWorkerHandlers();
      worker.onstdio = (stream, text) => activeConsoleHandler?.(stream, text);
      return;
    }
    const blob = new Blob([source], { type: 'application/javascript' });
    workerBlobURL = URL.createObjectURL(blob);
    worker = new Worker(workerBlobURL, { type: 'classic' });
    attachWorkerHandlers();
  }

  function attachWorkerHandlers() {
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
            if (msg.stats) {
              wasmStats.fuelUsed = msg.stats.fuelUsed;
              wasmStats.totalFuelUsed += msg.stats.fuelUsed;
              wasmStats.peakMemoryBytes = Math.max(wasmStats.peakMemoryBytes, msg.stats.peakMemoryBytes);
            }
            if (msg.success) {
              entry.resolve(msg.value);
            } else {
              const err = new Error(msg.error?.message || 'Evaluation failed');
              err.name = msg.error?.name || 'Error';
              if (msg.error?.code) err.code = msg.error.code;
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
      // A Worker that fails while starting up (script error, engine load
      // failure) must reject createSandbox()/restart instead of hanging it.
      if (rejectConfigure) rejectConfigure(new Error(`Worker error: ${e.message}`));
      // Reject all pending on Worker error
      for (const [id, entry] of pending) {
        pending.delete(id);
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error(`Worker error: ${e.message}`));
      }
    };
  }

  let rejectConfigure = null;
  async function configureWorker() {
    const { promise, resolve, reject } = makeDeferred();
    rejectConfigure = reject;
    const handler = ({ data }) => {
      if (data.type === 'configured') {
        worker.removeEventListener('message', handler);
        if (data.error) {
          const err = new Error(`Failed to load the WASM engine: ${data.error.message}`);
          err.code = 'ERR_ANDBOX_ENGINE';
          reject(err);
        } else {
          resolve();
        }
      }
    };
    worker.addEventListener('message', handler);
    worker.postMessage({
      type: 'configure',
      importMap,
      baseURL,
      virtualModules: Object.fromEntries(virtualModules),
      ...(wasmConfig ? { wasm: { ...wasmConfig.engine, memoryBytes: wasmConfig.limits.memoryBytes } } : {}),
    });
    try {
      await promise;
    } finally {
      rejectConfigure = null;
      worker?.removeEventListener('message', handler);
    }
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
    beginOp();
    try {
      terminateWorker();
      createWorker();
      worker.ref?.();
      await configureWorker();
    } finally {
      endOp();
    }
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
    if (wasmConfig) {
      for (const k of ['fuel', 'memoryBytes', 'stackBytes', 'deadlineMs']) checkLimit(k, opts[k]);
    }
    if (!worker || worker.dead) await restartWorker();
    beginOp();

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

    // mode: 'wasm' -- limits travel with the call. The in-worker deadline
    // (default: this call's timeoutMs) ends a busy loop gracefully; the
    // host-side timer below becomes a hard-kill backstop a little later.
    let wasmLimits = null;
    let backstopMs = timeoutMs;
    if (wasmConfig) {
      const base = wasmConfig.limits;
      const deadline = opts.deadlineMs ?? base.deadlineMs ?? (timeoutMs > 0 ? timeoutMs : 0);
      wasmLimits = {
        fuel: opts.fuel ?? base.fuel,
        memoryBytes: opts.memoryBytes ?? base.memoryBytes,
        stackBytes: opts.stackBytes ?? base.stackBytes,
        deadlineMs: deadline,
      };
      if (timeoutMs > 0) backstopMs = Math.max(timeoutMs, deadline) + WASM_BACKSTOP_GRACE_MS;
    }

    let timer = null;
    if (backstopMs > 0) {
      timer = setTimeout(() => {
        pending.delete(id);
        reject(makeTimeoutError(timeoutMs));
        // Hard kill and restart — only reliable way to stop infinite loops
        restartWorker().catch(() => {});
      }, backstopMs);
    }

    // AbortSignal support
    if (opts.signal) {
      if (opts.signal.aborted) {
        if (timer) clearTimeout(timer);
        endOp();
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
    worker.postMessage({ type: 'evaluate', id, code, ...(wasmLimits ? { limits: wasmLimits } : {}) });

    // Restore console handler when evaluation completes
    return promise.finally(() => {
      if (opts.onConsole) activeConsoleHandler = prevConsoleHandler;
      endOp();
    });
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
      beginOp();
      const { promise, resolve } = makeDeferred();
      const handler = ({ data }) => {
        if (data.type === 'moduleDefined' && data.name === name) {
          worker.removeEventListener('message', handler);
          resolve();
        }
      };
      worker.addEventListener('message', handler);
      worker.postMessage({ type: 'defineModule', name, source });
      try { await promise; } finally { endOp(); }
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
      ...(wasmConfig ? { fuelUsed: wasmStats.fuelUsed, peakMemoryBytes: wasmStats.peakMemoryBytes, totalFuelUsed: wasmStats.totalFuelUsed } : {}),
    };
  }

  // ── Initialize ──
  beginOp();
  try {
    createWorker();
    await configureWorker();
  } catch (e) {
    // e.g. the WASM engine failed to load: do not leave the thread running.
    terminateWorker();
    throw e;
  } finally {
    endOp();
  }

  return {
    evaluate,
    defineModule,
    dispose,
    stats,
    isDisposed: () => disposed,
  };
}
