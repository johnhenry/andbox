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
 * @param {SandboxOptions} [options]
 * @returns {{ execute: Function, terminate: Function } | Promise<{ evaluate: Function, defineModule: Function, dispose: Function, isDisposed: () => boolean }>}
 */
export function createSandbox(options = {}) {
  const mode = options.mode || 'worker';
  if (mode === 'inline') return createInlineSandbox(options);
  if (mode === 'data-uri') return createDataUriSandbox(options);
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
  let evalSeq = 0;
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

    const id = ++evalSeq;
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
