/**
 * Node adapter: a Web-Worker-shaped object on top of `node:worker_threads`.
 *
 * The browser path builds a Blob URL and passes it to `new Worker(url)`.
 * Node has no global `Worker`, `worker_threads` cannot start from a `blob:`
 * URL, and the ESM loader cannot `import()` one. So in Node the worker
 * source is passed as text with `{ eval: true }` (the thread starts as a
 * CommonJS script, which is all the worker source needs), preceded by a
 * small prelude that maps `parentPort` onto `self.postMessage` /
 * `self.onmessage` / `self.close`, and shims `Blob` + `URL.createObjectURL`
 * *inside the thread only* so the worker's virtual-module loader mints
 * `data:` URLs (which Node can `import()`) instead of `blob:` URLs. The
 * worker source itself is the same string the browser uses.
 *
 * Virtual modules in the thread are served by `node-vfs.mjs` (in-thread
 * `module.registerHooks`), so they can import each other relatively, by
 * bare name, and through the sandbox import map. The VFS source is inlined
 * into the prelude via `Function.prototype.toString`.
 *
 * Opt-in hardening (`nodeWorker.permissions`) spawns the thread with Node's
 * permission model, an isolated `env`, a heap cap, captured stdio, and a
 * stripped `process`. None of this makes a worker thread a security boundary;
 * see the README's Security model.
 *
 * `node:worker_threads` is loaded with a dynamic `import()` so the browser
 * entry never pulls a `node:` specifier into a bundle's static graph.
 */

import { installNodeVfs } from './node-vfs.mjs';

function makePrelude({ harden }) {
  return `
const { parentPort } = require('node:worker_threads');
const __exit = process.exit.bind(process);
const __vfs = (${installNodeVfs.toString()})(require('node:module').registerHooks);
delete globalThis[Symbol.for('andbox.vfs')];
Object.defineProperty(globalThis, '__andboxNodeVirtual', {
  configurable: true,
  value(name, modules, importMap) {
    __vfs.setImportMap('sb', importMap);
    for (const [n, src] of modules) __vfs.define('sb', n, src);
    return import(__vfs.urlOf('sb', name));
  },
});
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
globalThis.close = () => __exit(0);
parentPort.on('message', (data) => {
  try { const r = globalThis.onmessage?.({ data }); r?.catch?.((e) => { throw e; }); }
  catch (e) { parentPort.postMessage({ type: 'error', message: String(e?.message ?? e) }); }
});
// import(blob:) is unsupported by Node's ESM loader; data: works.
globalThis.Blob = class AndboxNodeBlob {
  constructor(parts) { this.text = parts.map(String).join(''); }
};
URL.createObjectURL = (b) => 'data:text/javascript;base64,' + Buffer.from(b.text).toString('base64');
URL.revokeObjectURL = () => {};

${harden ? `
__vfs.denyHostResources();
for (const k of ['binding', '_linkedBinding', 'getBuiltinModule', 'dlopen', 'kill', 'abort', '_kill', 'reallyExit', 'mainModule', 'moduleLoadList']) {
  try { delete process[k]; } catch {}
}
` : ''}
`;
}

class NodeWebWorker {
  #thread;
  #listeners = new Set();
  #terminated = false;
  onmessage = null;
  onerror = null;

  dead = false;
  onstdio = null;

  constructor(ThreadWorker, source, config) {
    const w = new ThreadWorker(makePrelude({ harden: config.harden }) + '\n' + source, config.workerOptions);
    if (config.workerOptions.stdout) w.stdout.on('data', (d) => this.onstdio?.('stdout', String(d)));
    if (config.workerOptions.stderr) w.stderr.on('data', (d) => this.onstdio?.('stderr', String(d)));
    w.on('message', (data) => {
      const ev = { data };
      this.onmessage?.(ev);
      for (const fn of [...this.#listeners]) fn(ev);
    });
    w.on('error', (e) => this.onerror?.({ message: e?.message ?? String(e) }));
    w.on('exit', (code) => {
      this.dead = true;
      if (!this.#terminated && code !== 0) {
        this.onerror?.({ message: `worker exited with code ${code}` });
      }
    });
    this.#thread = w;
  }

  postMessage(m) {
    if (!this.#terminated) this.#thread.postMessage(m);
  }
  addEventListener(type, fn) { if (type === 'message') this.#listeners.add(fn); }
  removeEventListener(type, fn) { if (type === 'message') this.#listeners.delete(fn); }
  /** Let the process exit while the thread is idle / keep it alive. */
  ref() { if (!this.dead) this.#thread.ref(); }
  unref() { if (!this.dead) this.#thread.unref(); }
  terminate() {
    this.#terminated = true;
    this.#listeners.clear();
    this.#thread.terminate();
  }
}

/** True when running under Node (including with no global `Worker`). */
export function isNodeRuntime() {
  return typeof process !== 'undefined' && typeof process?.versions?.node === 'string';
}

/**
 * Load `node:worker_threads` and return a synchronous factory
 * `(workerSource: string) => Worker-like` (onmessage/onerror/postMessage/
 * addEventListener/removeEventListener/terminate). Pass it as the
 * `workerFactory` option of `createSandbox()` to force it explicitly.
 *
 * @returns {Promise<(source: string) => object>}
 */
export async function createNodeWorkerFactory(options = {}) {
  if (!isNodeRuntime()) {
    throw new Error("createNodeWorkerFactory() requires Node (node:worker_threads); in a browser use mode: 'worker'.");
  }
  // Non-literal specifier: bundlers (webpack 5 fails on an unresolvable
  // `node:` scheme) must not try to resolve this browser-irrelevant import.
  const specifier = 'node:' + 'worker_threads';
  const { Worker: ThreadWorker } = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
  const config = resolveNodeWorkerConfig(options);
  return (source) => new NodeWebWorker(ThreadWorker, source, config);
}

const DEFAULT_HARDENED_MEMORY_MB = 256;

/**
 * Turn the public `nodeWorker` options into `Worker` constructor
 * options.
 */
export function resolveNodeWorkerConfig(options = {}) {
  const { permissions = false, env, maxMemoryMb, resourceLimits, execArgv, captureStdio } = options;
  if (maxMemoryMb !== undefined && !(Number.isFinite(maxMemoryMb) && maxMemoryMb > 0)) {
    throw new Error('nodeWorker.maxMemoryMb must be a positive number (megabytes)');
  }
  const workerOptions = { eval: true };
  const memory = maxMemoryMb ?? (permissions ? DEFAULT_HARDENED_MEMORY_MB : undefined);
  if (memory !== undefined || resourceLimits) {
    workerOptions.resourceLimits = {
      ...(memory !== undefined ? { maxOldGenerationSizeMb: memory } : {}),
      ...resourceLimits,
    };
  }
  if (env !== undefined) workerOptions.env = env;
  else if (permissions) workerOptions.env = {};
  const argv = [...(permissions ? ['--permission'] : []), ...(execArgv ?? [])];
  if (argv.length) workerOptions.execArgv = argv;
  if (captureStdio ?? permissions) {
    workerOptions.stdout = true;
    workerOptions.stderr = true;
  }
  return { workerOptions, harden: permissions };
}
