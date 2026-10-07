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
 * `node:worker_threads` is loaded with a dynamic `import()` so the browser
 * entry never pulls a `node:` specifier into a bundle's static graph.
 */

const PRELUDE = `
const { parentPort } = require('node:worker_threads');
globalThis.self = globalThis;
globalThis.postMessage = (m) => parentPort.postMessage(m);
globalThis.close = () => process.exit(0);
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
`;

class NodeWebWorker {
  #thread;
  #listeners = new Set();
  #terminated = false;
  onmessage = null;
  onerror = null;

  constructor(ThreadWorker, source) {
    const w = new ThreadWorker(PRELUDE + '\n' + source, { eval: true });
    w.on('message', (data) => {
      const ev = { data };
      this.onmessage?.(ev);
      for (const fn of [...this.#listeners]) fn(ev);
    });
    w.on('error', (e) => this.onerror?.({ message: e?.message ?? String(e) }));
    w.on('exit', (code) => {
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
export async function createNodeWorkerFactory() {
  if (!isNodeRuntime()) {
    throw new Error("createNodeWorkerFactory() requires Node (node:worker_threads); in a browser use mode: 'worker'.");
  }
  // Non-literal specifier: bundlers (webpack 5 fails on an unresolvable
  // `node:` scheme) must not try to resolve this browser-irrelevant import.
  const specifier = 'node:' + 'worker_threads';
  const { Worker: ThreadWorker } = await import(/* @vite-ignore */ /* webpackIgnore: true */ specifier);
  return (source) => new NodeWebWorker(ThreadWorker, source);
}
