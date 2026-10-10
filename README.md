# andbox

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Fandbox.svg)](https://www.npmjs.com/package/@johnhenry/andbox)
[![CI](https://github.com/johnhenry/andbox/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/andbox/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Fandbox.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/andbox](https://opensource.johnhenry.me/andbox/)

A separate-context JavaScript runtime with Worker isolation, RPC capabilities, import maps, and timeouts.

andbox runs JavaScript in a dedicated Web Worker with a structured bridge back to the host. Code in that Worker can call host-provided "capabilities" via RPC, use import-mapped packages, and define virtual modules -- all with configurable rate limits, timeouts, and hard-kill semantics.

**andbox's job is running code in its own context with a clean RPC surface, not containing adversarial code.** The Worker boundary keeps well-behaved code from touching the DOM or host globals by accident, and gives you rate limits, timeouts, and a kill switch for code you trust but don't want to block on or grant unrestricted access to. It is **not** a security sandbox: code that specifically tries to escape can reach `fetch`, `WebSocket`, `Worker`, and other Worker-global APIs directly, regardless of what capabilities you grant. See [Security model](#security-model) before using andbox to run code you don't trust.

Zero dependencies. Uses only Web Workers and standard browser APIs.

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Sandbox Modes](#sandbox-modes)
- [Node](#node)
- [`mode: 'wasm'`](#mode-wasm)
- [`mode: 'iframe'`](#mode-iframe)
- [Mediated network: `network`](#mediated-network-network)
- [Bridges: sharing a host API](#bridges-sharing-a-host-api)
- [Chrome AI bridge](#chrome-ai-bridge)
- [API](#api)
- [Execution model](#execution-model)
- [Security model](#security-model)
- [Threat model by mode](#threat-model-by-mode)
- [Family](#family)
- [License](#license)

## Install

```bash
npm install @johnhenry/andbox
```

Or via CDN (no bundler needed):

```js
import { createSandbox } from 'https://esm.sh/@johnhenry/andbox';
```

> **Provenance:** previously published as `andbox@0.1.1`. This package restarts
> versioning at `0.0.0` under the `@johnhenry` scope.

## Quick Start

```js
import { createSandbox } from '@johnhenry/andbox';

const sandbox = await createSandbox({
  capabilities: {
    readFile: async (path) => { /* host-side file read */ },
    writeFile: async (path, content) => { /* host-side file write */ },
  },
  importMap: {
    imports: {
      'lodash': 'https://esm.sh/lodash',
    },
  },
  onConsole: (level, ...args) => console.log(`[sandbox:${level}]`, ...args),
});

// Evaluate code in the sandbox
const result = await sandbox.evaluate(`
  const greeting = 'Hello from the sandbox!';
  console.log(greeting);

  // Call a host capability
  const content = await host.call('readFile', '/etc/hostname');
  return content;
`);

// Define a virtual module
await sandbox.defineModule('utils', `
  export function add(a, b) { return a + b; }
`);

// Import the virtual module from sandbox code
await sandbox.evaluate(`
  const { add } = await sandboxImport('utils');
  return add(2, 3); // 5
`);

// Clean up
await sandbox.dispose();
```

## Sandbox Modes

andbox supports seven execution modes (any other `mode` throws an error listing these):

- **`worker`** (default) -- Runs in a dedicated Worker with an RPC bridge, import maps, virtual modules, and hard-kill timeout semantics. See [Security model](#security-model) for what this does and doesn't protect against.
- **`node-worker`** -- The `worker` mode on `node:worker_threads`. Selected automatically under Node when there is no global `Worker`; see [Node](#node).
- **`wasm`** -- Optional. Runs the code in QuickJS-ng compiled to WebAssembly *inside* the Worker (or worker thread), with `host.call` as the only authority and real memory, stack, fuel and deadline limits. The only mode that withholds the Worker's own globals (`fetch`, `WebSocket`, `importScripts`, ...). See [`mode: 'wasm'`](#mode-wasm).
- **`iframe`** -- Browser only. Runs the code in a sandboxed `<iframe sandbox="allow-scripts" srcdoc>`: an opaque origin with its own realm, `window` and `document`, so the code can render real DOM (charts, canvas animations, HTML) that you mount in your page. Same API as `worker`. The first mode with a browser-enforced origin boundary; see [`mode: 'iframe'`](#mode-iframe) for what that does and does not cover.
- **`inline`** -- Same-thread execution via AsyncFunction. Lighter weight, no Worker overhead, no isolation at all -- code runs with full access to the calling context. Only for code you already trust.
- **`data-uri`** -- Dynamic `import()` via Blob URL (a `data:` URL under Node). Module-level separation without a Worker. Supports globals injection.
- **`service-worker`** -- Not code execution at all: registers a Service Worker that serves an in-memory `path → content` map with real HTTP-shaped fetch/navigation semantics. For hosting a small virtual multi-file site (HTML/CSS/JS, arbitrary paths), not for running JS in isolation. See [andbox#14](https://github.com/johnhenry/andbox/issues/14) and [Security model](#security-model) -- this mode does **not** provide isolation by merely existing.

```js
// Inline mode (no Worker)
const inline = createSandbox({ mode: 'inline', globals: { math: Math } });
const result = await inline.execute('return math.sqrt(16)');

// Data-URI mode
const dataUri = createSandbox({ mode: 'data-uri', globals: { x: 42 } });
const result = await dataUri.execute('print(x)');

// Service-Worker mode (browser only -- see examples/06-service-worker-mode/)
const site = await createSandbox({
  mode: 'service-worker',
  scriptURL: '/andbox-sw.js', // you serve makeServiceWorkerSource()'s output here
  scope: '/virtual/',
  files: { '/virtual/hello.html': '<h1>Hello</h1>' },
});
// Only navigate into scope *after* this resolves -- see Security model.
```

## Node

From 0.0.4 no shim is needed. Under Node (`engines >= 26`), `createSandbox()` just works:

```js
import { createSandbox } from '@johnhenry/andbox';
const sandbox = await createSandbox({ capabilities: { now: () => Date.now() } });
await sandbox.evaluate('return await host.call("now")');
await sandbox.dispose(); // worker threads keep the process alive until disposed
```

**Mode selection.** `mode: 'worker'` (the default) picks `node:worker_threads` when `typeof Worker === 'undefined'` and the runtime is Node; if a global `Worker` exists (browser, or a shim you installed) that is used as before. `mode: 'node-worker'` forces the Node implementation. `workerFactory: (source) => WorkerLike` overrides both; `createNodeWorkerFactory()` is exported for that purpose.

**How it works.** The same worker script the browser uses is passed to `new worker_threads.Worker(prelude + source, { eval: true })`. No blob URLs are created. The prelude maps `parentPort` to `self.postMessage`/`onmessage`/`close` and installs an in-thread module loader hook (`module.registerHooks`) that serves virtual modules from memory (see below). `node:worker_threads` is loaded with a dynamic `import()` so browser bundles never see a `node:` specifier. Timeouts, `AbortSignal`, and `dispose()` hard-kill the thread with `terminate()` and a fresh one is started on the next call.

**Virtual modules can import each other (0.0.6).** `defineModule()` modules are served under `andbox-vfs://` URLs, so they can import one another relatively (`./b`, `../lib/c.js`), by bare name (`import x from "lib/x"`), through the sandbox `importMap`, and cyclically. Extensions are optional (`./b`, `./b.js`, `./b/index.js` all find `b`). Redefining a module (or a dependency) takes effect on the next `sandboxImport()`. Difference from the browser: modules are cached per definition, so repeated `sandboxImport(name)` returns the same module instance until it is redefined. `createVirtualModuleRegistry()` uses the same mechanism under Node (see its section).

**Process lifetime.** A live worker thread keeps the host process alive until `dispose()` (confirmed by test: no `dispose()` and the process never exits; after `dispose()` it exits). Pass `unref: true` to let the process exit while the sandbox is *idle*: the thread is unref'd between calls and ref'd again while a startup, `evaluate()` or `defineModule()` is in flight, so an `await sandbox.evaluate(...)` is never abandoned. Default `false`. (Ignored with a browser Worker.)

**Hardening (opt-in): `nodeWorker`.** By default the thread behaves like any `worker_threads` thread: it gets a copy of `process.env`, no memory cap, and full access to `process`, `fs`, `child_process`, etc. These options tighten that:

```js
const sandbox = await createSandbox({
  nodeWorker: {
    permissions: true,        // see below
    // env: { MODE: 'x' },    // explicit env; with permissions the default is {}
    // maxMemoryMb: 128,      // heap cap (default 256 with permissions: true)
    // resourceLimits: {...}, // raw worker_threads resourceLimits, merged on top
    // execArgv: [...],       // extra thread flags, e.g. '--allow-fs-read=/data'
    // captureStdio: true,    // route thread stdout/stderr to onConsole('stdout'|'stderr', text)
  },
});
```

`permissions: true` does all of the following to the thread:

- **Permission model.** Spawns it with `execArgv: ['--permission']` (this works per-thread in Node 26 even though the flag is documented process-wide). Verified by test: `fs` reads and `child_process` are denied with `ERR_ACCESS_DENIED`, Nested workers and native addons are not granted (`--allow-worker` / `--allow-addons` are not passed), though only the `fs` and `child_process` denials are covered by tests. Grant specific paths with `execArgv: ['--allow-fs-read=/dir']`.
- **Isolated `env`.** `{}` (or the object you pass) instead of a copy of the host's environment, so secrets in `process.env` are not visible.
- **Memory cap.** `resourceLimits.maxOldGenerationSizeMb` (default 256, or `maxMemoryMb`). An allocation loop kills the thread with an out-of-memory error, the pending `evaluate()` rejects, and the next call starts a fresh thread. (andbox has no other memory-limit option, so `maxMemoryMb` is new here; `policy.limits` only governs capability calls.)
- **Stripped `process`.** Deletes `process.binding`, `_linkedBinding`, `getBuiltinModule`, `dlopen`, `kill`, `abort`, `reallyExit`, `mainModule`.
- **Blocked host imports.** A resolve hook rejects any `import()` / `sandboxImport()` that resolves to a `node:` or `file:` URL (`import('node:fs')`, `import('fs')`, `import('file:///...')`). `data:`, `http(s):` and virtual modules still work.
- **Captured stdio.** Thread `process.stdout/stderr` writes go to `onConsole` instead of the host terminal.

**What this does *not* prevent.** The thread is still in your process. `permissions` does not restrict the network (`fetch`, `WebSocket`, `net` via any route that remains), CPU use (use `timeoutMs`), or anything that exploits a bug in V8 or Node; the `process` stripping and import hook are denylists, not a proof, and a determined attacker may find another path to a host capability. It only reduces the blast radius of ordinary and semi-hostile code. See [Security model](#security-model). The options throw if combined with a browser Worker or a custom `workerFactory`, rather than silently doing nothing.

**Not supported / differences.**

- `mode: 'service-worker'` needs a browser and rejects under Node.
- **A worker thread is not a security boundary** -- not by default and not with `nodeWorker.permissions`. By default sandboxed code can reach `process` (including `process.env`, `process.binding`, `process.getBuiltinModule('fs')`) and can `import('node:child_process')`. For untrusted code on a server add OS-level isolation (a separate process or container with its own filesystem, network and resource limits).

## `mode: 'wasm'`

`mode: 'wasm'` (added in 0.0.8, [andbox#21](https://github.com/johnhenry/andbox/issues/21)) is the "different execution strategy" the [Security model](#security-model) says `worker` mode is missing. The code you `evaluate()` is not run by the Worker's JavaScript engine at all: it runs in [QuickJS-ng](https://github.com/quickjs-ng/quickjs) compiled to WebAssembly, in the same Worker (browser) or `worker_thread` (Node) andbox already uses. A fresh QuickJS runtime and context is created for every `evaluate()`.

The engine has no `fetch`, `WebSocket`, `XMLHttpRequest`, `importScripts`, `indexedDB`, `postMessage`, `self`, `Worker`, timers or `process`: they are not hidden, they simply do not exist in that engine. Its only way out is the single native function behind `host.call(name, ...args)`, which goes through the same `capabilityCall` message, `gateCapabilities()` and `policy` as worker mode. `sandboxImport()` and `import()` resolve **only** virtual modules (`defineModule()`); no URL is ever fetched.

```js
import { createSandbox } from '@johnhenry/andbox';

const sandbox = await createSandbox({
  mode: 'wasm',
  capabilities: { readFile: async (path) => { /* host side */ } },
  fuel: 50_000,              // interrupt polls, deterministic (default: unlimited)
  memoryBytes: 32 * 1024 * 1024, // JS heap cap (default 64 MiB)
  stackBytes: 128 * 1024,    // guest stack cap (default 128 KiB)
  deadlineMs: 2_000,         // cooperative wall-clock deadline (default: the call's timeoutMs)
});

await sandbox.evaluate('return await host.call("readFile", "/etc/hostname")');
```

### Installing the engine (optional, pinned)

The engine is an **optional** peer dependency, pinned to exact versions, so the default install stays dependency-free:

```sh
npm install --save-exact quickjs-emscripten-core@0.32.0 @jitl/quickjs-ng-wasmfile-release-sync@0.32.0
```

Without them `createSandbox({ mode: 'wasm' })` rejects with `ERR_ANDBOX_ENGINE_MISSING` and the install command above. Every other mode is unaffected.

**Node:** nothing else to do. andbox finds the installed packages and the `.wasm` file itself.

**Browser, no CDN:** the Worker needs two files from your own origin: the engine as one ES module, and the `.wasm` file. Build them once:

```sh
npx esbuild node_modules/@johnhenry/andbox/src/wasm-engine.mjs \
  --bundle --format=esm --platform=browser --minify --outfile=public/andbox-quickjs.mjs
cp node_modules/@jitl/quickjs-ng-wasmfile-release-sync/dist/emscripten-module.wasm public/andbox-quickjs.wasm
```

and point andbox at them (relative URLs resolve against `baseURL`, which defaults to the page URL):

```js
const sandbox = await createSandbox({
  mode: 'wasm',
  engineURL: '/andbox-quickjs.mjs',
  wasmURL: '/andbox-quickjs.wasm',
});
```

Or give them through the sandbox import map, so a page that already has one needs no new option: `importMap: { imports: { '@johnhenry/andbox/wasm-engine': '/andbox-quickjs.mjs', '@johnhenry/andbox/wasm': '/andbox-quickjs.wasm' } }`. Serve the `.wasm` as `application/wasm`. Size: about 54 KB for the engine module (15 KB gzipped) plus 528 KB for the `.wasm` (248 KB gzipped); the main `andbox` entry grows by about 10 KB minified (4 KB gzipped) for the extra worker source. `examples/08-wasm-browser/` is a complete working build + server + headless-Chrome check.

### Limits

| Option (sandbox or per `evaluate()` call) | What it does | Reported as |
|---|---|---|
| `fuel` | Budget of interrupt-handler polls (QuickJS polls about once per 10,000 VM operations). Counted, not timed, so the same code stops at the same count on every run. `sandbox.stats().fuelUsed` shows the last call's count. Guest code cannot catch it. | `FuelExhaustedError`, `code: 'ERR_ANDBOX_FUEL_EXHAUSTED'` |
| `memoryBytes` | Cap on the guest JS heap (checked while the code runs, on a time budget of roughly 10% overhead) plus QuickJS's own limit, which rejects any single allocation above it. The engine's whole linear memory also gets a hard maximum of about `2 * memoryBytes + 32 MiB`, which is what actually bounds `ArrayBuffer` and similar allocations. | `MemoryLimitError`, `code: 'ERR_ANDBOX_MEMORY_LIMIT'` |
| `stackBytes` | QuickJS call-stack cap. Overflow is an ordinary, catchable guest `RangeError`. | `RangeError` |
| `deadlineMs` | Wall-clock deadline for the whole call, including time spent awaiting host calls. Checked in the interrupt handler and by a timer. The Worker survives; no respawn. Defaults to the call's `timeoutMs`. | `TimeoutError`, `code: 'ERR_ANDBOX_DEADLINE'` |
| `timeoutMs` | Unchanged, but in this mode it is the **backstop**: the host `terminate()`s the Worker `max(timeoutMs, deadlineMs) + 1000 ms` after the call starts, which covers anything that stops the engine from polling. `AbortSignal` still terminates and restarts the Worker. | `TimeoutError` / `AbortError` |

`stats()` additionally returns `fuelUsed`, `peakMemoryBytes` (sampled) and `totalFuelUsed`. The error classes are plain `Error`s with the `name` and `code` shown; `WASM_ERROR_CODES` exports the codes. An exception that escapes the engine itself (for example the host stack overflowing when `stackBytes` is set far above the default) is caught and reported as `EngineError` / `ERR_ANDBOX_ENGINE`; the engine is reloaded for the next call.

### Differences from worker mode

- `host.call` arguments and results, and the value you `return`, are JSON-serialised (worker mode uses structured clone). `undefined`, functions (`'[Function]'`) and `BigInt` (as a string) are handled as in worker mode; `Map`, `Set`, `Date` and typed arrays are not preserved.
- Each `evaluate()` starts from a fresh global scope. Nothing set on `globalThis` survives; use `defineModule()` or the host for shared state.
- `sandboxImport()` is limited to virtual modules (relative imports, bare names and import-map names that point at a virtual module name all work). An import map entry that points at a URL does not make that URL loadable.
- Capability arguments are JSON, so a capability that expects non-JSON values will not get them.
- Concurrent `evaluate()` calls on one sandbox share the Worker's single thread: a busy loop in one delays the others (their deadlines are wall-clock). Use one sandbox per tenant if that matters.
- `nodeWorker.permissions` is rejected with this mode for now (the Worker has to read the engine from disk). The other `nodeWorker` options work.
- A guest can catch the engine's out-of-memory error and keep running inside the cap; it cannot exceed the cap.
- `Date`, `Math.random` and `performance` exist in the guest (QuickJS provides them from the host clock); see the threat model.

## `mode: 'iframe'`

`mode: 'iframe'` (0.1.2) runs evaluated code in a sandboxed `<iframe>` instead of a Worker, for code that needs a real DOM: a notebook pane that draws a chart, plays a canvas animation, or renders HTML. It is the cross-origin-iframe option [andbox#10](https://github.com/johnhenry/andbox/issues/10) named next to `mode: 'wasm'`. The frame is created from `srcdoc` with `sandbox="allow-scripts"` and **no** `allow-same-origin`, so the browser gives it an opaque origin: it cannot read your page, your cookies or your storage.

```js
import { createSandbox } from '@johnhenry/andbox';

const pane = await createSandbox({
  mode: 'iframe',
  container: document.querySelector('#pane'),    // where the frame goes (default: offscreen in <body>)
  html: '<style>body { margin: 0 }</style>',      // initial body markup
  capabilities: { data: () => [3, 7, 4, 9] },
  onConsole: (level, ...args) => console.log(`[pane:${level}]`, ...args),
  onFrame: (iframe) => { iframe.className = 'pane-frame'; }, // every new frame, before it is attached
});

await pane.evaluate(`
  const canvas = document.createElement('canvas');   // the frame's own document
  document.body.append(canvas);
  const values = await host.call('data');
  // ... draw, animate, play(Scene, { canvas }) ...
  return values.length;
`);

pane.iframe.style.height = '300px'; // the live element; size it like any other
```

**Same contract as worker mode.** `evaluate(code, opts)` wraps the code in an async IIFE and resolves with what it `return`s, by structured clone (`Map`, `Date`, typed arrays survive; a DOM node rejects with `DataCloneError`). `host.call(name, ...args)` goes through the same capability gate and `policy`, and capabilities get the same `this.signal`. `sandboxImport()` resolves virtual modules (`defineModule()`), the `importMap`, and remote URLs under the same `allowedImportHosts` rules. `console.*` is forwarded to `onConsole` (sandbox-level or per call). `timeoutMs`/`defaultTimeoutMs` and an `AbortSignal` hard-kill the frame (it is removed and a fresh one created) and reject with the same `TimeoutError` / `AbortError` as worker mode. `stats()`, `dispose()` and `isDisposed()` are unchanged.

**Differences from worker mode.**

- **The code has a full browser window.** `window`, `document`, `fetch`, timers and `requestAnimationFrame` are the frame's own; nothing is deleted or shadowed (the worker-mode lockdown does not apply, the origin boundary does). `document.body.append(...)` renders where you mounted the frame. With [`network`](#mediated-network-network), `fetch` is replaced by the host-backed one.
- **`sandbox.iframe` is the live element, and it changes.** A timeout, an abort, or the frame navigating/reloading itself replaces it with a new element in the same place, with the same attributes (`class`, `style`, `width`, ...); everything the old document held is gone. `onFrame(iframe)` is called for every new frame before it is attached, so set things up there if you need them on every frame, or insert the frame yourself there. `sandbox.iframe` is `null` after `dispose()`.
- **Do not move the element in the DOM.** Re-parenting an iframe reloads its document. andbox notices (the pending call rejects with `Sandbox iframe unloaded ...`) and the next call gets a fresh frame, but state is lost. Pass `container` (or place it in `onFrame`) instead.
- **Remote modules are cross-origin requests.** The frame's origin is `null`, so a module URL must be served with `Access-Control-Allow-Origin` (CDNs such as esm.sh do). A relative `sandboxImport('./x.js')` resolves against `baseURL` (default: your page URL) and needs the same header.
- **`csp`** is injected as `<meta http-equiv="Content-Security-Policy">` after andbox's bootstrap script. `evaluate()` compiles code with `new Function`, so a policy that restricts scripts must allow `'unsafe-eval'`, plus `blob:` for `defineModule()` modules and the hosts you import from. Example: `"default-src 'none'; script-src 'unsafe-eval' blob: https://esm.sh; img-src data:"` leaves the frame no network except module imports from esm.sh.
- **`iframeSandbox: ['allow-forms', 'allow-popups', ...]`** adds sandbox tokens. `'allow-same-origin'` is refused: combined with `allow-scripts` it puts the frame in your origin, where it can reach your page and storage and delete its own `sandbox` attribute. `dangerouslyAllowSameOrigin: true` permits it for code you trust completely.
- **Browser only.** Without a DOM (Node, a Worker) `createSandbox({ mode: 'iframe' })` rejects. `workerFactory`, `nodeWorker` and the wasm limits do not apply; `untrusted: true` still means `mode: 'wasm'`.
- **Startup is bounded** by `defaultTimeoutMs`: a frame that never completes its handshake (for example a `container` that is not in a document) rejects `createSandbox()` and is removed.

**Synchronous infinite loops depend on the browser's process model.** An `await`-based hang (a promise that never settles, a long `setInterval`) is always killed on time. A synchronous `while (true) {}` can only be killed when the browser runs the frame on another thread:

- **Desktop Chrome** (site isolation on, the default; checked with Chrome 154) runs a sandboxed frame in its own renderer process. The timeout fires on time, the frame is removed, and the next call gets a new frame in milliseconds, **provided no other sandboxed frame from your site shares that process**. Chrome groups them by site, so while another andbox iframe (or any other opaque-origin frame from your site) is alive, the looping process cannot be shut down: the replacement frame lands in it and its startup times out, and those other frames stop responding too.
- **WebKit (Safari's engine) and Chromium without full site isolation** (measured: Playwright's WebKit, and Playwright's Chromium without `--site-per-process`) run the frame on the host page's main thread. A synchronous infinite loop freezes your page, the timeout cannot fire, and the browser's own "page unresponsive" handling is the only way out. Chrome on Android, which does not isolate every site, is expected to behave the same; Firefox was not measured for this release.

Use `mode: 'wasm'` (fuel and deadline inside the engine) or `worker` mode for code that may spin, and `iframe` mode for code that needs the DOM. `examples/09-iframe-browser/` is a working two-pane notebook demo; `test/browser/iframe-mode.spec.mjs` runs the contract in Chromium, Firefox and WebKit.

## Mediated network: `network`

Worker mode removes `fetch` from the sandbox. Code you hand a capability to can call `host.call(...)`, but a library imported into the sandbox (`d3.json()`, `ky`, an API client) calls the **global** `fetch` and fails. The `network` option (0.1.3, [andbox#39](https://github.com/johnhenry/andbox/issues/39)) installs a global `fetch` in the sandbox that sends every request to a function on the host, which decides what happens. **No network unless you list hosts:** since 0.2.0 ([andbox#43](https://github.com/johnhenry/andbox/issues/43)) `network.allowedHosts` is required, so setting `network` never means "every host" by accident:

```js
import { createSandbox } from '@johnhenry/andbox';

const sandbox = await createSandbox({
  network: {
    allowedHosts: ['api.example.com'],            // required: checked on the host before fetch is called
    // Optional. Runs on the host for every allowed request. Same signature as fetch.
    async fetch(url, init) {
      console.log(init.method, url);              // you see every request
      return fetch(url, { ...init, referrerPolicy: 'no-referrer' }); // init.credentials is 'omit'
    },
  },
  policy: { capabilities: { fetch: { maxCalls: 100 } } }, // the usual gate applies
});

await sandbox.defineModule('lib', `export const getJSON = async (u) => (await fetch(u)).json();`);
await sandbox.evaluate(`
  const { getJSON } = await sandboxImport('lib'); // knows nothing about andbox
  return getJSON('https://api.example.com/items');
`);
```

**Inside the sandbox**, `fetch(input, init)` resolves relative URLs against `baseURL`, refuses anything that is not `http:`/`https:` with a `TypeError`, lets the platform normalise the method, headers and body (strings, typed arrays, `Blob`, `FormData`, `URLSearchParams`, a `Request`), and sends only the URL, method, header pairs, body and `redirect` mode to the host. `credentials`, `mode`, `cache`, `referrer` and the other `RequestInit` fields are dropped. It resolves with a real `Response` (`status`, `statusText`, `headers`, `url`, `redirected`, `json()`/`text()`/`arrayBuffer()`/`body`). A host error rejects with `TypeError('fetch failed: ...')`, and `init.signal` rejects the call with `AbortError`. Everything else on the lockdown list (`XMLHttpRequest`, `WebSocket`, `EventSource`, `WebTransport`, `importScripts`, ...) stays removed.

**On the host**, the request becomes an ordinary capability named `fetch`, so it goes through the capability gate and `policy` like any other (`policy.capabilities.fetch` limits it; `stats().gate.perCapability.fetch` counts it; binary bodies travel as base64, so `maxArgBytes` counts them). The host side treats it as untrusted input, because evaluated code can also call `host.call('fetch', url, init)` directly: it checks the URL again (http(s) only), validates the method, header pairs, body and `redirect`, checks the host against `allowedHosts`, and then calls your function as `fetch(url, init)` with `init.headers` a `Headers`, `init.body` a string or `Uint8Array`, `init.credentials` set by the host, and `init.signal` aborted when the sandbox is terminated (it is called without a `this`, so `network: { allowedHosts, fetch }` with the platform's own `fetch` works). Return a `Response`, or a plain `{ status, statusText, headers, body, url, redirected }` (`body` a string, `ArrayBuffer`, typed array or `Blob`). `Set-Cookie` is never passed to the sandbox, and opaque or error responses (`status` outside 200-599) reject.

| `network` field | Type | Default | Description |
|---|---|---|---|
| `allowedHosts` | `string[] \| (url: URL) => boolean \| '*'` | **required** | Which hosts the sandbox may reach, checked on the host before `fetch` is called (forms below). Leaving it out throws at `createSandbox()`. |
| `fetch` | `(url, init) => Response \| { status, headers, body, ... }` | the platform's global `fetch` | Host function for every request `allowedHosts` lets through. |
| `credentials` | `'omit' \| 'same-origin' \| 'include'` | `'omit'` | What the host passes as `init.credentials`. The sandbox cannot change it. |

**`allowedHosts` takes one of three forms:**

```js
// 1. A list of hostnames: the sandbox reaches these and nothing else.
network: { allowedHosts: ['api.example.com', 'cdn.example.com'] }

// 2. A function, asked on the host for every request (and every redirect hop):
//    for an allowlist that changes while the sandbox runs, like a notebook
//    that asks the user per host. Only `true` (or a promise of it) allows.
const approved = new Set(['api.example.com']);
network: { allowedHosts: (url) => approved.has(url.hostname) }

// 3. The explicit opt-in to any http(s) host. Your fetch is then the whole
//    policy, so write it next to one that enforces its own rules.
network: { allowedHosts: '*', fetch: myPolicyFetch }
```

- **A list** matches the request URL's hostname exactly: case-insensitive, normalised the way `URL` does it (IDN to punycode, IPv4 forms to dotted decimal), on any port and either scheme. There is no subdomain or wildcard matching: `'example.com'` does not allow `api.example.com`, and `'api.example.com'` does not allow `example.com`. Write IPv6 in brackets (`'[::1]'`). An entry with a scheme, port, path or `*` throws instead of silently never matching, and an empty list throws (to give the sandbox no network, leave `network` out). It is [`createNetworkFetch()`](#createnetworkfetchallowedhosts-fetchfn) in front of your `fetch`.
- **A function** gets a fresh `URL` (changing it does not change the request). Anything other than `true` refuses with `Network access denied: <host> is not allowed by network.allowedHosts`; if it throws, the sandbox's `fetch` rejects with that error's message, which is a good place for "allow this host in settings". It may be `async`.
- **`'*'`** skips the host check (the URL must still be http(s)) and leaves everything else, redirects included, to your `fetch`. Without a `fetch`, it is the platform's `fetch` for any host.

**Redirects.** With a list, every request is made with `redirect: 'manual'` and any redirect response is refused, so an allowlisted host cannot send the request elsewhere. With a function, andbox follows redirects itself: each request is made with `redirect: 'manual'`, and for every `Location` it asks your function again before requesting it (at most 20 hops; 301/302 after a `POST` and 303 become a `GET` without a body, as the Fetch standard does; `Authorization` is dropped when the hop changes origin). The sandbox sees the final `url` and `redirected: true`; `redirect: 'error'` from the sandbox rejects on a redirect and `redirect: 'manual'` returns it unfollowed. A browser's own `fetch` hides a manual redirect's target (an `opaqueredirect` response), so over the page's `fetch` a function policy cannot check the next hop and the request **fails** rather than following it blindly; on Node, Deno and Bun, or with a `network.fetch` that returns the 3xx response, redirects are followed and checked. With `'*'`, your `fetch` receives the sandbox's `redirect` mode and decides; the platform `fetch` follows redirects to any host.

**On a server, the host function has the server's network position.** With `node-worker` (or any server-side host), whatever `allowedHosts` lets through is fetched from inside your network: `localhost`, private addresses, and cloud metadata endpoints such as `169.254.169.254` are reachable if the policy allows them. Prefer a list; with a function or `'*'`, refuse private and link-local addresses yourself (and remember DNS can point a public name at one).

**Modes.** `worker` and `node-worker`: the shim is the only `fetch` the code can reach by name. `iframe`: it replaces the frame's own `fetch`, but the frame still has its other network APIs (`XMLHttpRequest`, `WebSocket`, `<img>`, `import()`); add `csp: "connect-src 'none'"` (and `default-src` as needed) to leave the host function as the only way to fetch, since the shim talks to the host over a `MessagePort` that CSP does not affect. `wasm`, `inline`, `data-uri` and `service-worker` throw if `network` is given (in `wasm`, expose a capability and use `host.call()`). Passing both `network` and a capability named `fetch` throws.

**Limits.** The response body is buffered on the host and copied into the sandbox (no streaming; enforce size limits in your function, for example from `content-length` and `arrayBuffer().byteLength`). Aborting the sandbox-side `signal` rejects the call immediately but does not cancel the host request; terminating the sandbox does (`init.signal`). The rebuilt `Response` has `type: 'default'`. What this does and does not narrow is in the [Security model](#security-model).

## Bridges: sharing a host API

A capability is one function. Some host APIs are more than that: a model session you create, prompt several times and destroy; a stream of chunks; a call you want to cancel; a progress callback. `bridges` (0.3.0, [andbox#46](https://github.com/johnhenry/andbox/issues/46)) shares such an API with sandboxed code **without sharing a host object**. Each entry becomes a global in the sandbox whose methods send structured-clone messages to functions you define on the host. It is the same pattern as [`network`](#mediated-network-network): a sandbox-side shim backed by a gated host side.

```js
import { createSandbox, defineBridge } from '@johnhenry/andbox';

const notes = defineBridge({            // defineBridge() only validates; a plain object works too
  api: {
    // Every method gets a context first: ctx.signal, ctx.state, ctx.handle(), ctx.target.
    open: { handle: true, call: (ctx, name) => ctx.handle('Notebook', new Notebook(name)) },
    search: (ctx, query, options) => db.search(query, { signal: ctx.signal }),
  },
  handles: {
    Notebook: {                                   // host objects the sandbox holds handles to
      methods: {
        add: (ctx, text) => ctx.target.add(text), // ctx.target is the host object
        read: { stream: true, call: (ctx) => ctx.target.entries() }, // ReadableStream or (async) iterable
      },
      props: ['name', 'size'],                    // copied to the sandbox, refreshed after every call
      destroy: (notebook) => notebook.close(),    // on handle.destroy() and when the sandbox goes away
    },
  },
  limits: { maxHandles: 4, maxStreams: 2, maxResultBytes: 1_000_000, timeoutMs: 30_000 },
  onRequest: async ({ method, args, handle }) => askTheUser(method, args), // only `true` allows
});

const sandbox = await createSandbox({
  bridges: { notes },
  policy: { capabilities: { 'notes.Notebook.add': { maxCalls: 100 } } }, // the gate applies per method
});

await sandbox.evaluate(`
  const book = await notes.open('ideas');          // a handle: methods, props, destroy()
  await book.add('hello');
  for await (const entry of book.read()) console.log(entry); // a ReadableStream, pulled chunk by chunk
  const c = new AbortController();
  setTimeout(() => c.abort(), 100);
  await notes.search('x', { signal: c.signal }).catch((e) => e.name); // 'AbortError'; ctx.signal aborts on the host
  book.destroy();
`);
```

**Inside the sandbox** the global (`notes`, also on `globalThis`, so imported libraries see it) has the `api` tree as nested namespaces of async methods. Arguments and results cross by structured clone (`Map`, `Date`, typed arrays, `Blob` survive; a result that cannot be cloned rejects with `DataCloneError` instead of leaking anything). Host errors reject with their `name` and `message` (a `DOMException` name such as `NotAllowedError` or `QuotaExceededError` becomes a `DOMException`, `TypeError`/`RangeError` stay those types; the host stack never crosses).

- **Handles.** A method that returns `ctx.handle(type, object)` gives the sandbox an ordinary object with the type's methods, its `props` as read-only getters (snapshot values, refreshed after every call on it), `destroy()` and `[Symbol.dispose]`. The host object stays on the host under a random id. A handle can be passed back as an argument (the host method receives the host object). After `destroy()`, calls reject with `InvalidStateError` and pending ones with `AbortError`, as Chrome's AI sessions do. Mark a method `handle: true` so `limits.maxHandles` is checked before it runs (otherwise an over-limit object is destroyed right after it is made).
- **Streams.** A `stream: true` method returns a `ReadableStream` at once (like `promptStreaming()`), async-iterable in every engine. It is pull-driven: the host reads its stream or iterator only when the sandbox asks for the next chunk, so a slow reader slows the producer. `cancel()`, a `break` out of `for await`, an aborted signal or `limits.timeoutMs` cancel the host stream and abort `ctx.signal`.
- **Abort.** An `AbortSignal` anywhere in the arguments rejects the call in the sandbox with the signal's reason at once and aborts `ctx.signal` on the host. An already-aborted signal never reaches the host. `ctx.signal` also aborts on timeout, `destroy()` of the handle, and when the Worker/frame is terminated.
- **Callbacks (reverse calls).** A function in the arguments becomes an async proxy on the host: calling it runs the function **in the sandbox** and resolves with its (cloned) result. It lives as long as the call, or, when the call returned a handle, as long as that handle; after that, and when the sandbox goes away, calling the proxy rejects. Use it for progress events and anything the host must ask the sandbox; never for code you would run on the host.

**On the host**, every method call is a capability call in the [capability gate](#gatecapabilitiescapabilities-policy) named `${bridge}.${method}` (`notes.open`, `notes.Notebook.add`), so `policy` limits it and `stats().gate.perCapability` counts it; `host.call()` cannot reach those names. Then `onRequest` is asked (if given), then the method runs. `stats().bridges.notes` shows live `handles`, `streams` and `pendingCalls`, plus whatever the definition's `stats(state)` returns.

| Definition field | Type | Description |
|---|---|---|
| `api` | tree of methods | Namespaces and methods of the global. A method is `(ctx, ...args) => value` or `{ call, stream?, handle?, requiresUserActivation? }`. |
| `handles` | `{ [type]: { methods?, props?, destroy? } }` | Host object types. `methods` get `ctx.target`; `props` are copied (primitives and arrays of primitives); `destroy(target)` releases it. |
| `limits` | `{ maxHandles, maxStreams, maxResultBytes, timeoutMs }` | Per sandbox; defaults 32, 8, 0, 0 (0 = unlimited). `maxResultBytes` is approximate (strings as UTF-8, binary by `byteLength`) and applies to each result and stream chunk; `timeoutMs` covers one call, and a stream until it ends (`TimeoutError`). |
| `onRequest` | `(request) => boolean \| Promise<boolean>` | Consent hook: `{ bridge, method, args, handle, requiresUserActivation, userActivation, signal }`. Only `true` allows; `false`, anything else or a throw rejects in the sandbox with `NotAllowedError` (a thrown error's message is kept). It may wait for the user; `request.signal` aborts if the sandbox gives up. Asked for every method call, not for `destroy()`, cancel or abort. |
| `createState`, `stats` | functions | Per-sandbox state (`ctx.state`, kept across restarts) and extra `stats()` fields. |
| `client`, `clientOptions` | function, JSON | A self-contained function run **in the sandbox** with the generated global, to adapt shapes a message cannot carry (the Chrome AI bridge uses it for `monitor`). |
| `globals` | `{ alias: 'path' }` | Extra sandbox globals pointing into the api, e.g. `{ LanguageModel: 'languageModel' }`. |

**User activation.** Some host APIs need a gesture on the page (Chrome's model download). andbox cannot grant activation, and the sandbox cannot produce it. Mark the method `requiresUserActivation: true | 'transient' | 'sticky'`, or a function `(ctx, ...args)` that decides per call. `onRequest` then sees `requiresUserActivation` and the page's current `userActivation`, and after it allows, andbox checks `navigator.userActivation` and refuses with `NotAllowedError` if the page has none. The way an app satisfies it: show a button and resolve `onRequest` **from its click handler**, so the method runs while the page has activation (sticky activation lasts for the page's lifetime; transient lasts a few seconds). Where the platform has no `navigator.userActivation` (Node), the check is skipped.

**Lifetime.** Handles, streams and callbacks belong to the Worker or frame that made them. When it is terminated (`dispose()`, a timeout or abort of `evaluate()`, a crash, an iframe navigation) every handle's `destroy` runs on the host, every stream is cancelled, every in-flight call's `ctx.signal` aborts, and pending reverse calls reject. The next `evaluate()` runs in a fresh runtime with a fresh global. Keep `defaultTimeoutMs` above your slowest bridge call: a timed-out `evaluate()` destroys the sandbox's handles with the runtime.

**Modes.** `worker`, `node-worker` (the host API just has to exist in Node) and `iframe`. `wasm`, `inline`, `data-uri` and `service-worker` throw if `bridges` is given: the QuickJS guest has no `ReadableStream`, `AbortSignal` or `EventTarget` and only JSON crosses its boundary, so in `wasm` expose capabilities and use `host.call()`. A bridge name or alias must be an identifier that is not a runtime name (`host`, `sandboxImport`, `console`, `fetch`, `self`, ...); method names may not be `then`, `constructor`, `destroy` and the like; a capability with a bridge method's gate name throws.

**Not supported (v1).** Events on handles (`addEventListener` on a session, e.g. Chrome's `contextoverflow`), getters that change between calls without a call (props are snapshots), passing a stream or a function *in a result*, and markers: an argument object with an own `__andbox_bridge__` key is read as a function/signal/handle reference.

## Chrome AI bridge

Chrome's built-in AI APIs (`LanguageModel`, `Summarizer`, `Writer`, `Rewriter`, `Translator`, `LanguageDetector`, `Proofreader`) exist only in Window contexts: not in Workers, and in a sandboxed opaque-origin iframe they are blocked by permissions policy (`availability()` is `'unavailable'`, `create()` throws `NotAllowedError`; measured in Chromium). So sandboxed code can only reach the on-device model through the page. `@johnhenry/andbox/bridges/chrome-ai` is that bridge, with no dependencies:

```js
import { createSandbox } from '@johnhenry/andbox';
import { chromeAI } from '@johnhenry/andbox/bridges/chrome-ai';

const sandbox = await createSandbox({
  bridges: {
    ai: chromeAI({
      apis: ['languageModel', 'summarizer'],          // default: all seven
      budgets: { maxInputTokens: 20_000, maxInputTokensPerCall: 2_000 },
      onRequest: (request) => consentDialog(request), // e.g. resolve(true) from an "Allow" button's click handler
    }),
  },
  defaultTimeoutMs: 120_000, // model calls are slow; a timed-out evaluate() destroys its sessions
});

await sandbox.evaluate(`
  if (await ai.languageModel.availability() === 'unavailable') return null;
  const session = await ai.languageModel.create({
    initialPrompts: [{ role: 'system', content: 'Be brief.' }],
    monitor(m) { m.addEventListener('downloadprogress', (e) => console.log(e.loaded)); },
  });
  let text = '';
  for await (const chunk of session.promptStreaming('Summarize andbox.')) text += chunk;
  console.log(session.contextUsage, '/', session.contextWindow);
  session.destroy();
  return text;
`);
```

**In the sandbox**, `ai.languageModel`, `ai.summarizer`, `ai.writer`, `ai.rewriter`, `ai.translator`, `ai.languageDetector` and `ai.proofreader` mirror the platform constructors: `availability(options)`, `create(options)` (plus `params()` for `languageModel` where the host has it, i.e. extensions). `chromeAI({ globals: true })` also installs `LanguageModel`, `Summarizer`, ... as sandbox globals, so code written for the page runs unchanged. Sessions are handles with the platform's methods and attributes:

| API | Methods | Attributes (snapshots) |
|---|---|---|
| `languageModel` | `prompt`, `promptStreaming`, `append`, `measureContextUsage`, `measureInputUsage`, `clone`, `destroy` | `contextUsage`, `contextWindow`, `samplingMode`; legacy `inputUsage`, `inputQuota`, `topK`, `temperature` where the host has them |
| `summarizer`, `writer`, `rewriter` | `summarize`/`write`/`rewrite`, their `...Streaming`, `measureInputUsage`, `destroy` | `sharedContext`, `type`/`tone`, `format`, `length`, `expectedInputLanguages`, `expectedContextLanguages`, `outputLanguage`, `inputQuota` |
| `translator` | `translate`, `translateStreaming`, `measureInputUsage`, `destroy` | `sourceLanguage`, `targetLanguage`, `inputQuota` |
| `languageDetector` | `detect`, `measureInputUsage`, `destroy` | `expectedInputLanguages`, `inputQuota` |
| `proofreader` | `proofread`, `measureInputUsage`, `destroy` | `includeCorrectionTypes`, `includeCorrectionExplanations`, `expectedInputLanguages`, `correctionExplanationLanguage` |

**On the host**, the platform objects are looked up on `globalThis` at call time (`chromeAI({ scope })` substitutes another object, which the tests use for a fake). An API the browser lacks reports `'unavailable'` and its `create()` rejects with `NotSupportedError`; a method the browser lacks rejects with `NotSupportedError`. Every call passes the platform the call's `ctx.signal`, so a sandbox-side `signal`, `session.destroy()`, a timeout or the sandbox going away aborts the model call. Gate names are `ai.languageModel.create`, `ai.LanguageModel.prompt`, `ai.Summarizer.summarize`, ... (`policy.capabilities['ai.LanguageModel.prompt']`). Default limits: 8 live sessions and 4 open streams per sandbox.

- **Consent and the download gesture.** `onRequest` sees every call, e.g. `{ method: 'LanguageModel.prompt', args: ['...'] }`, and can show the prompt text, refuse, or wait. `create()` needs a user gesture when the model is not on disk yet (`availability()` is `'downloadable'`); the bridge then reports `requiresUserActivation: 'sticky'` and refuses with `NotAllowedError` if the page has never had activation. Resolve `onRequest` from a click handler (an "Allow download" button) and the download proceeds. The check is against the page that owns the bridge, and activation is not consent: a click *inside* an `iframe` sandbox also activates its parent page (the HTML spec propagates activation to ancestor frames; measured in WebKit), so sandboxed code that gets the user to click its own button satisfies the activation check. Decide in `onRequest`, with UI the sandbox cannot draw.
- **Token budgets.** `budgets.maxInputTokensPerCall` and `budgets.maxInputTokens` (per sandbox) are enforced on the host: before every `prompt`, `promptStreaming`, `append`, `summarize`, `write`, `rewrite`, `translate`, `detect` and `proofread`, the input is measured with the session's `measureContextUsage()` (or `measureInputUsage()`), and a call over budget rejects with `QuotaExceededError` (`requested`, `quota`) before it reaches the model. The tokens `initialPrompts` use count at `create()`. Output tokens are not counted (each session's `contextWindow` bounds them). With a budget set, an API that cannot measure (the Proofreader spec has no `measureInputUsage`) rejects instead of running unmetered. `stats().bridges.ai.inputTokens` is the running total.
- **`monitor`** works as on the page: it is called in the sandbox with an `EventTarget` that receives `downloadprogress` events (`loaded` 0 to 1, `total` 1; a `ProgressEvent` where the runtime has one), forwarded from the host's monitor as reverse calls.

**Differences from the platform API.**

- `create()` options and inputs cross by structured clone: images and audio must be cloneable (`Blob`, `ImageBitmap`, `ImageData`, `ArrayBuffer`; not `AudioBuffer`); an `HTMLCanvasElement` or `HTMLImageElement` from an iframe sandbox's document rejects with `DataCloneError`, so convert it first.
- Attributes are snapshots refreshed after each call on the session; there are no events on sessions (`contextoverflow`/`quotaoverflow` are not forwarded).
- `measureContextUsage()` and `measureInputUsage()` are both available and call whichever the browser has.
- **Tool use.** Chrome's Prompt API has no `execute` callback: tool use is open-loop and, as of Chrome 152, behind a flag. The bridge passes tool declarations through, returns `tool-call` content as plain `{ callId, name, arguments }` objects, and turns `tool-response` content you send back into the platform's `LanguageModelToolSuccess`/`LanguageModelToolError`. A tool with an `execute` function is refused with `NotSupportedError` rather than silently ignored; when the platform gains closed-loop tools, bridging `execute` is a reverse call (it would run in the sandbox, never on the host).
- `samplingMode`, `topK`, `temperature`, `params()`: whatever the host's browser supports (the web ignores `topK`/`temperature`; `params()` exists only in extensions).

**Where it works.** The host must be a page (Window) where the API is enabled: Chrome desktop 138+ for Summarizer, Translator and LanguageDetector, 148+ for the Prompt API on the web; Writer, Rewriter and Proofreader are origin-trial or flag only. A page inside a cross-origin iframe needs `allow="language-model; summarizer; ..."` delegated to it. `test/browser/bridges.spec.mjs` runs the bridge against a fake `LanguageModel` in Chromium, Firefox and WebKit (CI has no model) and a smoke test against the real API where the browser has it; `examples/11-chrome-ai-browser/` is a working page with a consent prompt.

## API

### `createSandbox(options?)`

Creates a new sandboxed runtime. Returns a promise (Worker, wasm and iframe modes) or object (inline/data-uri mode).

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'worker' \| 'node-worker' \| 'wasm' \| 'iframe' \| 'inline' \| 'data-uri' \| 'service-worker'` | `'worker'` | Execution mode |
| `importMap` | `{ imports?, scopes? }` | `{}` | Import map for package resolution (Worker mode) |
| `capabilities` | `Record<string, Function>` | `{}` | Host functions callable via `host.call()` (Worker mode) |
| `defaultTimeoutMs` | `number` | `30000` | Default timeout for `evaluate()` |
| `baseURL` | `string` | `location.href` | Base URL for relative imports |
| `allowedImportHosts` | `string[]` | unset | Restricts `sandboxImport()` of remote `http(s)` modules to these hostnames (plus `baseURL`'s own host). **Unset: remote imports are allowed.** Provided: only listed hosts; `[]` denies all remote imports. Import-map targets are host-authored and always allowed. |
| `untrusted` | `boolean` | `false` | Convenience for untrusted code: selects `mode: 'wasm'`. Throws if combined with another `mode`, and rejects (never falls back to a Worker) if wasm mode is unavailable. See [Security model](#security-model). |
| `policy` | `GatePolicy` | -- | Rate limiting policy |
| `onConsole` | `(level, ...args) => void` | -- | Console output handler |
| `globals` | `Record<string, any>` | `{}` | Global variables (inline/data-uri modes) |
| `engineURL`, `wasmURL` | `string` | -- | `mode: 'wasm'`: same-origin URLs of the bundled engine module and the `.wasm` (optional under Node) |
| `fuel`, `memoryBytes`, `stackBytes`, `deadlineMs` | `number` | see [Limits](#limits) | `mode: 'wasm'` limits (also accepted per `evaluate()` call) |
| `container` | `Element` | offscreen in `document.body` | `mode: 'iframe'`: element the frame is appended to. A restarted frame takes its predecessor's place instead. |
| `html` | `string` | `''` | `mode: 'iframe'`: initial `<body>` markup of every new frame |
| `csp` | `string` | -- | `mode: 'iframe'`: Content-Security-Policy for the frame (`<meta http-equiv>`); must allow `'unsafe-eval'` if it restricts scripts |
| `iframeSandbox` | `string[]` | `[]` | `mode: 'iframe'`: extra sandbox tokens (`allow-scripts` is always set); `'allow-same-origin'` throws unless `dangerouslyAllowSameOrigin` |
| `dangerouslyAllowSameOrigin` | `boolean` | `false` | `mode: 'iframe'`: permit `'allow-same-origin'`, which removes the origin boundary |
| `onFrame` | `(iframe) => void` | -- | `mode: 'iframe'`: called with every new frame (first and after each restart) before it is attached |
| `network` | `{ allowedHosts, fetch?, credentials? }` | unset | `worker`, `node-worker`, `iframe`: install a global `fetch` in the sandbox that sends every request through the host function (the gated `fetch` capability). `allowedHosts` is required (a hostname list, a `(url) => boolean` function, or `'*'`); without it `createSandbox()` throws. **Unset: no `fetch` in worker modes** (unchanged). See [Mediated network](#mediated-network-network). |
| `bridges` | `Record<string, BridgeDefinition>` | unset | `worker`, `node-worker`, `iframe`: one sandbox global per entry that proxies a host API, with handles, streams, abort, callbacks, consent and budgets. See [Bridges](#bridges-sharing-a-host-api) and the [Chrome AI bridge](#chrome-ai-bridge). |

**Returns (Worker mode):** `Promise<{ evaluate, defineModule, dispose, stats, isDisposed }>`. `mode: 'iframe'` adds `iframe`, the live `HTMLIFrameElement` (`null` after `dispose()`, replaced after a restart; see [`mode: 'iframe'`](#mode-iframe)).

### `sandbox.evaluate(code, opts?)`

Evaluates JavaScript code in the sandbox. The code is wrapped in an async IIFE -- use `return` to produce a result.

| Option | Type | Description |
|--------|------|-------------|
| `timeoutMs` | `number` | Override default timeout |
| `signal` | `AbortSignal` | Abort evaluation |
| `onConsole` | `(level, ...args) => void` | Per-call console handler |

**Inside sandbox code (Worker mode):**

- `host.call(name, ...args)` -- Call a host capability by name
- `sandboxImport(name)` -- Import a virtual module
- `console.log/warn/error/info` -- Forwarded to host `onConsole`

### `sandbox.defineModule(name, source)`

Defines a virtual module that sandbox code can import via `sandboxImport(name)`.

### `sandbox.dispose()`

Terminates the Worker (removes the frame in `mode: 'iframe'`) and rejects all pending evaluations.

### `sandbox.stats()`

Returns runtime statistics including pending evaluations, virtual modules, and gate stats.

### `gateCapabilities(capabilities, policy?)`

Wraps host functions with rate limiting and payload caps.

```js
import { gateCapabilities } from '@johnhenry/andbox';

const { gated, stats } = gateCapabilities(
  { fetch: async (url) => (await fetch(url)).text() },
  {
    limits: { maxCalls: 100, maxArgBytes: 1_000_000, maxConcurrent: 8 },
    capabilities: { fetch: { maxCalls: 50 } },
  }
);
```

### `resolveWithImportMap(specifier, importMap, parentURL?)`

Resolves a module specifier against an import map, following the browser import map algorithm.

### `createVirtualModuleRegistry(files?, options?)`

Takes a `path → source` map and mints one importable URL per entry: a real `blob:` URL in a browser (the same `new Blob([...]) + URL.createObjectURL()` pattern `data-uri` mode uses, generalized to a whole file table), or, under Node (which cannot `import()` a `blob:` URL), an `andbox-vfs://<id>/<path>?v=<n>` URL served by an in-thread module hook. `options.backend` is `'auto'` (default), `'blob'` or `'node'`. Returns a registry for a multi-file tree that references itself by relative path -- an entry module `import`-ing `./util.js`, which itself imports `../shared/x.js`, and so on.

```js
import { createVirtualModuleRegistry } from '@johnhenry/andbox';

const registry = createVirtualModuleRegistry({
  'index.js': 'import { add } from "./util.js"; export const result = add(2, 3);',
  'util.js': 'export function add(a, b) { return a + b; }',
});

registry.resolve('index.js');                       // importable URL, or null if unknown
registry.source('index.js');                        // the registered source text
registry.resolveSpecifier('./util.js', 'index.js');  // resolves relative to the importing file
registry.define('extra.js', 'export const x = 1;');  // register (or replace) a file at runtime
registry.dispose();                                  // revokes blob URLs / drops the Node files
```

`resolveSpecifier(specifier, parentPath?)` checks, in order: (1) import-map resolution via `resolveWithImportMap()` -- not reimplemented, just delegated, with `parentPath`'s own blob URL passed through as `parentURL` so `scopes` apply; (2) a relative-path (`./`, `../`) fallback looked up against the registry's own file table, which `resolveWithImportMap()` alone has no notion of; (3) `null` if neither matched, e.g. a genuine external bare specifier -- left for the caller to handle, not swallowed.

**Under Node, relative imports just work.** `await import(registry.resolve('index.js'))` runs `index.js`, whose `./util.js` import is resolved by the hook (relative, bare-name, import map, cycles, and extensionless/`index.js` lookups). Redefine a file with `define()` and import the new URL it returns.

**Honest caveat (browser / `blob:` backend):** this only solves module *resolution* (the URL a given specifier should point at), not automatic rewriting of `import` statements inside the source text, and not general asset URLs (`<img src>`, CSS `url()`) or navigation. A `blob:` URL has no hierarchical path of its own, so a literal `import "./util.js"` statement inside blob-served source will **not** resolve on its own in a browser -- call `resolveSpecifier()` yourself with the specifier your loader saw and use the URL it returns (or rewrite the specifier to that URL before creating the blob). See [andbox#13](https://github.com/johnhenry/andbox/issues/13) for the full design discussion, and [andbox#14](https://github.com/johnhenry/andbox/issues/14) for the harder "make it behave like a real server" problem this deliberately does not attempt to solve.

### `createNetworkFetch(allowedHosts?, fetchFn?)`

Creates a fetch function that checks the request hostname against an allowlist before calling through. Requests are made with `redirect: 'manual'` and any redirect response is rejected, so an allowlisted host cannot send the caller elsewhere (see [Security model](#security-model)). It is what `network: { allowedHosts: [...] }` puts in front of the sandbox's `fetch`. Unlike `network.allowedHosts`, a missing or empty list here still allows every host ([andbox#44](https://github.com/johnhenry/andbox/issues/44)).

```js
import { createNetworkFetch } from '@johnhenry/andbox';

const gatedFetch = createNetworkFetch(['api.example.com']);
await gatedFetch('https://api.example.com/data'); // OK
await gatedFetch('https://evil.com/steal');        // throws
```

### `defineBridge(definition)`

Validates a bridge definition (throws a `TypeError` naming the problem) and returns it unchanged. Optional: `createSandbox({ bridges })` validates too. `DEFAULT_BRIDGE_LIMITS` holds the default `limits`. See [Bridges](#bridges-sharing-a-host-api).

### `chromeAI(options?)` (`@johnhenry/andbox/bridges/chrome-ai`)

The [Chrome AI bridge](#chrome-ai-bridge): `{ apis?, onRequest?, budgets?: { maxInputTokens?, maxInputTokensPerCall? }, limits?, globals?, scope? }`. `CHROME_AI_APIS` lists the API keys.

### `createStdio()`

Creates an async iterable stream for console output capture.

### `makeDeferred()`, `makeAbortError()`, `makeTimeoutError(ms)`

Promise and error utilities used internally, also available for consumers.

### `makeWorkerSource(options?)`

Returns the Worker script source code as a string (useful for custom Worker setups). `makeWorkerSource({ networkFetch: true })` is the variant `network` uses: `fetch` is the host-backed shim, which calls the host's `fetch` capability (your host must answer `capabilityCall` messages for it, as `createSandbox()` does).

### `createSandbox({ mode: 'service-worker', ... })`

Registers a Service Worker that backs a `path → content` map with real, same-origin, HTTP-shaped fetch and navigation semantics -- see [andbox#14](https://github.com/johnhenry/andbox/issues/14). Unlike the other three modes, this isn't code execution: it's for hosting a small virtual multi-file site (an in-memory archive of HTML/CSS/JS/anything) so that relative links, absolute-path links, runtime-computed `fetch()` calls, and `pushState`-based routing all work exactly as they would against a real server, because it *is* real HTTP-shaped navigation, transparently intercepted.

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `scriptURL` | `string` | **Required.** A real same-origin `http(s)` URL where you are already serving `makeServiceWorkerSource()`'s output. Service Worker registration requires a real `http(s)` scriptURL -- unlike `worker`/`data-uri` mode, a `blob:` URL is not accepted by the platform. |
| `scope` | `string` | Path prefix to register the Service Worker under. Defaults to `scriptURL`'s own directory. |
| `files` | `Record<string, string \| { body, contentType?, status?, headers? }>` | Initial served-file map. |
| `registry` | `VirtualModuleRegistry` | A [`createVirtualModuleRegistry()`](#createvirtualmoduleregistryfiles-options) instance to pull additional served content from -- its known paths' real blob content is fetched and merged in, reusing its path/blob bookkeeping instead of a second one. |
| `timeoutMs` | `number` | Max time to wait for the registration to become active before rejecting. Defaults to `DEFAULT_TIMEOUT_MS`. |

**Returns:** `Promise<{ scriptURL, scope, define(path, source, opts?), remove(path), dispose(), isDisposed() }>`. The promise resolves once the registration is **active**, rejects if it instead becomes `'redundant'` (its install/activate threw, or it failed to parse) or if `timeoutMs` elapses first -- see the ordering note in [Security model](#security-model) below before navigating anything into `scope`.

```js
import { createSandbox } from '@johnhenry/andbox';

const site = await createSandbox({
  mode: 'service-worker',
  scriptURL: '/andbox-sw.js', // you serve makeServiceWorkerSource()'s output here
  scope: '/virtual/',
  files: {
    '/virtual/hello.html': { body: '<h1>Hello</h1>', contentType: 'text/html' },
  },
});

// Only now -- with the registration active -- point something at the scope:
iframe.src = '/virtual/hello.html';

await site.define('/virtual/about.html', '<h1>About</h1>');
await site.dispose(); // unregisters the Service Worker
```

See `examples/06-service-worker-mode/` for a complete, runnable (browser-only) demo, including the dev server that serves the generated script.

### `makeServiceWorkerSource()`

Returns the Service Worker script source code as a string, for `mode: 'service-worker'`. Unlike `makeWorkerSource()`'s output (turned into a `blob:` URL for `new Worker(...)`), this string must be served as a real same-origin file -- Service Worker registration doesn't accept `blob:` scriptURLs.

### `resolveServiceWorkerResponse(pathname, files)`

Given a request pathname and a served-file map (`Map` or plain object), returns the `Response` the Service Worker's `fetch` handler would produce for an in-scope request, or `null` if it should fall through to the network. The pure logic factored out of the generated script, for testing and for embedding the same matching behavior elsewhere.

## Execution model

Code runs inside a Web Worker created from a Blob URL. This gets you, for free, against code that isn't specifically trying to defeat it:

- **No DOM access** -- Workers are inherently isolated from the document
- **No direct host object references** -- only what's explicitly passed in (capabilities, globals, import map entries) is reachable, so ordinary code can't accidentally touch host-side state
- **Hard kill** -- on timeout, the Worker is `terminate()`d and a fresh one is created for the next call
- **Virtual modules** -- modules defined via `defineModule()` are available via `sandboxImport()`
- **Capability rate limits** -- `gateCapabilities()` caps calls/concurrency/payload size per capability, for cooperative callers

## Security model

andbox is **not** a boundary against code that is actively trying to escape it. If you're running code you don't fully trust, read this section before you rely on `capabilities`/`policy`/`createNetworkFetch` for anything.

**Pick the mode by how much you trust the code:**

- **`worker` and `node-worker` are for trusted or semi-trusted code** (your own scripts, plugins from known authors, LLM output you review). They organise and throttle what the code does; they do not contain a determined attacker. Still reachable from code in these modes: the platform `import()` operator (fetches and runs remote code, an exfiltration channel; `allowedImportHosts` only governs `sandboxImport()`), timing and `SharedArrayBuffer`/`Atomics` side channels, the Worker's shared realm and heap, any global a future platform adds that is not on the deny-list, and under Node `process`, `require` and the rest of the Node API.
- **`iframe` is for code that needs the DOM**, trusted or semi-trusted, that you want kept away from your page. The browser enforces an origin boundary: the frame runs in an opaque origin and a separate realm, so it cannot read your document, cookies, storage or JavaScript objects, and it reaches you only through `host.call()` and the values it returns. It does not limit what the code does with its own window: network, CPU, memory, and (with the matching `iframeSandbox` tokens) popups and forms are its own. See "still yours" below and [`mode: 'iframe'`](#mode-iframe).
- **`wasm` is the mode for untrusted code**, and `createSandbox({ untrusted: true })` selects it (and throws or rejects instead of falling back if it is unavailable, or if combined with another `mode`). The code runs in QuickJS compiled to WebAssembly with no ambient authority: no `fetch`, `import()` of URLs, timers, `process` or `require` exist in that engine, and its only way out is `host.call()` through `capabilities`, `policy` and the gate. It has real limits (`fuel`, `memoryBytes`, `stackBytes`, `deadlineMs`) and a hard `terminate()` backstop. It does **not** guarantee: that your own capabilities are safe (whatever you grant is reachable, so keep them narrow), protection from engine or WebAssembly-runtime bugs (still shared process memory; for hostile multi-tenant workloads add OS-level isolation), that an in-flight capability is cancelled when the cooperative deadline fires ([andbox#35](https://github.com/johnhenry/andbox/issues/35)), or Node-level hardening (`nodeWorker.permissions` is not supported in this mode). See [`mode: 'wasm'`](#mode-wasm) and [andbox#10](https://github.com/johnhenry/andbox/issues/10).

**What andbox guarantees:**

- **No DOM access.** Worker-mode code executes in a real Worker global scope, which has no `document`, `window`, or other DOM references -- this is a platform property of Workers, not something andbox has to enforce itself.
- **No implicit host object references.** Only what you explicitly pass in (`capabilities`, `globals`, import map entries) is reachable from sandboxed code -- ordinary (non-adversarial) code cannot accidentally read or mutate host-side state it wasn't given a reference to.
- **(Node) A worker thread is not a security boundary.** It shares the process with the host; by default it inherits `process.env` and can reach `process`, `fs`, and `child_process`. The opt-in `nodeWorker.permissions` hardening (see [Node](#node)) adds the permission model, an isolated env, a memory cap and import blocking, which raises the cost of casual abuse but does not make the thread a boundary.
- **Hard kill on timeout.** `evaluate()` calls that exceed `timeoutMs` `terminate()` the Worker outright and start a fresh one for the next call -- this is a real process-level kill, not a cooperative cancellation the running code could ignore. See "still yours" below for what a kill does *not* undo.
- **The capability gate cannot be walked around via the prototype chain.** `gateCapabilities()` builds the gated object with `Object.create(null)`, so `host.call('constructor', ...)` cannot resolve through `Object.prototype` to the real global `Object` constructor; the host resolves names through a `Map` and rejects anything that was not explicitly granted. First fixed in 0.0.1, hardened in 0.0.9; see [andbox#5](https://github.com/johnhenry/andbox/issues/5).
- **`createNetworkFetch()`'s allowlist is redirect-safe.** Requests are made with `redirect: 'manual'` and any redirect response is rejected outright, so an allowlisted host cannot silently redirect a caller to a non-allowlisted one. Previously fixed; see [andbox#6](https://github.com/johnhenry/andbox/issues/6).
- **`gateCapabilities()` enforces call/argument-size/concurrency caps per capability**, for cooperative callers that stay within the capabilities you actually granted.
- **(`mode: 'iframe'`) An opaque origin and a separate realm, enforced by the browser.** The frame is `sandbox="allow-scripts"` without `allow-same-origin` (refused unless `dangerouslyAllowSameOrigin: true`). Its code gets `SecurityError` for `parent.document`, `top.location`, `parent.localStorage` and its own `localStorage`, has no access to your cookies, and shares no objects with your page: everything crossing the boundary is structured-cloned over a `MessagePort`. The port is handed over only after a handshake bound to that frame's own `contentWindow` and a per-frame random token (an `event.origin` of `'null'` alone proves nothing, since every opaque frame has it). Asserted by `test/browser/iframe-mode.spec.mjs`, which runs in Chromium, Firefox and WebKit.
- **(`bridges`) Host objects never cross.** A bridge sends only structured clones: the sandbox holds random handle ids, never the object; a result that cannot be cloned rejects with `DataCloneError`; host errors cross as `name` and `message` without the stack. Functions the sandbox passes run in the sandbox when the host calls them, never on the host. Every method call goes through the capability gate (`policy`, as `${bridge}.${method}`, unreachable through `host.call()`), then through the bridge's `onRequest`, where only `true` allows; `limits` cap live handles, open streams, result size and call time. Everything a runtime held (handles, streams, callbacks, in-flight calls) is destroyed or aborted on the host when it is terminated: `dispose()`, a timeout or abort, a crash, a frame navigation. Asserted by `test/bridges.test.mjs` and `test/browser/bridges.spec.mjs`. See [Bridges](#bridges-sharing-a-host-api).

**What is still yours:**

- **Worker-global APIs: partly removed, not contained.** Since 0.1.0 the worker prelude deletes `fetch`, `WebSocket`, `WebSocketStream`, `WebTransport`, `EventSource`, `XMLHttpRequest`, `Worker`, `SharedWorker`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`, `postMessage` and `self` from the global scope before any evaluated code runs (after the runtime has captured what it needs; with `network` set, `fetch` is replaced by the host-backed shim instead), shadows those names for evaluated code, and gives evaluated code a throwaway `this`. A script no longer gets them by name, through `globalThis`, indirect `eval` or `Function`. **This is hardening, not a boundary, and a Worker is not a security boundary.** Still reachable: the platform `import()` operator (syntax, it cannot be deleted or shadowed: it can fetch and execute remote code and is an exfiltration channel; `allowedImportHosts` only governs `sandboxImport()`), timing and `SharedArrayBuffer`/`Atomics` side channels, anything the engine or platform adds later that is not on the list above (a deny-list can only ever be incomplete), and under Node `process`, `require` and the rest of the Node API (use `nodeWorker.permissions`, and see [Node](#node)). Everything shares the Worker's realm and heap, so any prototype or intrinsic the code mutates is shared with the runtime. A different isolation primitive is required for hostile code: [`mode: 'wasm'`](#mode-wasm) (QuickJS in WebAssembly, no ambient authority) or a cross-origin iframe with a strict CSP. See [andbox#10](https://github.com/johnhenry/andbox/issues/10).
- **`sandboxImport()` remote imports: allowed unless `allowedImportHosts` is provided, and only `sandboxImport()` is governed.** With `allowedImportHosts` unset, absolute and protocol-relative `http(s)` specifiers load from any host (0.1.0 denied them by default; 0.1.1 reverted that). Pass `allowedImportHosts: [...]` to restrict to those hostnames plus `baseURL`'s own host (refused with `Import denied: <host> is not in allowedImportHosts`), or `allowedImportHosts: []` to deny all remote imports. Import-map targets and virtual modules are host-authored and unaffected. The check cannot see inside a module once loaded (its own static `import`s) and cannot stop the platform `import()` operator (see the previous item). `mode: 'wasm'` never fetches URLs at all. See [andbox#7](https://github.com/johnhenry/andbox/issues/7).
- **`network`: no network unless you list hosts.** `network.allowedHosts` is required (0.2.0, [andbox#43](https://github.com/johnhenry/andbox/issues/43)): a list of hostnames, a function asked about every request and redirect hop, or the explicit `'*'`, which hands the whole decision to your `fetch`. Setting `network` without it throws, so it can no longer mean "every host your function will fetch" by omission.
- **`network` narrows `fetch` to what `allowedHosts` and your host function allow; it does not close the other routes out.** With `network` set, the sandbox's global `fetch` is a shim: each request goes through the gated `fetch` capability, http(s) only, is checked against `allowedHosts` on the host, and reaches your function with `credentials` (default `'omit'`) chosen by the host and `Set-Cookie` withheld. That is a policy point for well-behaved code and the libraries it imports, not a wall: in worker mode the platform `import()` operator can still fetch (and run) arbitrary URLs and carry data out in them, as can `sandboxImport()` unless `allowedImportHosts` restricts it; in iframe mode the frame's own `XMLHttpRequest`, `WebSocket`, `<img>`, `<form>` and `import()` remain unless `csp` blocks them. Your function is what talks to the network on the sandbox's behalf with the host's network position (a server-side host can reach your internal network and cloud metadata endpoints): prefer an `allowedHosts` list, refuse private addresses in a function or `'*'` policy, and do not forward the sandbox's headers to hosts that trust them blindly. With `'*'`, redirects are whatever your `fetch` does. See [Mediated network](#mediated-network-network) and [andbox#39](https://github.com/johnhenry/andbox/issues/39).
- **A timeout cannot undo in-flight host-side effects; it can ask them to stop.** When the Worker is terminated (timeout, an aborted `evaluate()`, `dispose()`, a crash) every capability call still in flight sees `this.signal` abort, and its late result is dropped rather than delivered. Cancellation is cooperative: a capability that ignores `this.signal` still runs to completion on the host. Write effectful capabilities as `function`s (not arrows) and pass the signal on (`fetch(url, { signal: this.signal })`), and keep them idempotent. In `mode: 'wasm'`, a cooperative `deadlineMs` ends the evaluation without terminating the Worker, so the signal does not abort in that case. See [andbox#8](https://github.com/johnhenry/andbox/issues/8).
- **`bridges`: the bridged API's own risks are yours.** A bridge narrows *how* sandboxed code reaches a host API, not *what the API does* with what it is given:
  - **What the API can reach.** Whatever the bridged methods do, the sandbox can make them do, within `onRequest`, `policy` and `limits`. Validate arguments host-side like any capability; the arguments are untrusted input.
  - **An on-device model is an API that does what its input says.** Code with the Chrome AI bridge can prompt the model with anything the sandbox has: the data you gave it, the page content it was shown, text it built to manipulate the model (prompt injection). Show prompts in `onRequest` when the content matters, and use `budgets` to bound cost.
  - **Output is untrusted.** Model output (and any bridge result) is data from a source that the sandbox's input steered. Do not render it as HTML, run it or act on it without the same checks as any other untrusted input.
  - **Tool use.** Open-loop `tool-call` results are requests the model made on the sandbox's behalf; the sandbox decides what to run, inside the sandbox. A future closed-loop `execute` would also run in the sandbox. Nothing about tool use runs on the host unless your code does it.
  - **Consent UI and user activation.** `onRequest` is only as good as the UI you show. andbox cannot grant user activation, and activation is not consent: a click inside an `iframe` sandbox activates the page too. Put the decision in your own UI, outside any frame the sandbox draws.
  - **Lifetime.** `destroy` and `ctx.signal` are cooperative: a host method that ignores `ctx.signal` runs to completion (its late result is dropped and any handle in it destroyed), and a host object whose `destroy` throws is forgotten anyway.
- **`mode: 'iframe'`: the origin boundary is the whole guarantee.** Still yours:
  - **Network.** The frame has `fetch`, `WebSocket`, `import()`, `<img>`, `<form>` and so on, as a `null`-origin client: it can exfiltrate anything it was given or computed, and reach any server that answers cross-origin requests. Pass a `csp` (`default-src 'none'` plus what the code needs) to restrict it.
  - **CPU and memory.** An `await`-based hang is killed on time; a synchronous loop is killable only where the browser runs the frame out of process, and in Chrome only while no other frame from your site shares that process. WebKit/Safari (and Chromium without full site isolation) run the frame on your page's thread, where a busy loop freezes your page. No memory cap. See [`mode: 'iframe'`](#mode-iframe).
  - **Same process in some browsers.** Where the frame is not site-isolated (WebKit/Safari, Chromium without full site isolation such as Android Chrome, possibly Firefox) it shares a process and address space with your page: the origin boundary still holds for JavaScript, but a browser memory-safety bug or a Spectre-style read is not stopped by a process boundary. Timing side channels (`performance.now()`, `SharedArrayBuffer` where cross-origin isolation enables it) are available to the frame either way.
  - **What you enable.** Every `iframeSandbox` token is a capability: `allow-popups` lets it open windows, `allow-forms` submit forms, `allow-top-navigation` navigate your page, `allow-modals` show dialogs. `dangerouslyAllowSameOrigin` removes the boundary entirely.
  - **The UI it draws.** You chose to show the frame; it controls those pixels and can draw a convincing fake login form inside them. Keep frames visibly framed as untrusted content.
  - **What you grant and what you accept.** Capabilities are as reachable as in any other mode, and results are values from untrusted code.
- **`mode: 'service-worker'` does not provide isolation by merely existing.** It's a hosting mechanism -- a real Service Worker, same-origin by default, serving your `files` map with real fetch/navigation interception. Content served through it can see and touch its own origin exactly like any other same-origin page can; nothing about registering a Service Worker sandboxes what runs inside the pages it serves. If you're hosting content you don't fully trust, point this mode at a genuinely separate origin from day one -- the same recommendation the `fetch`/`WebSocket`/`Worker` item above makes for `worker` mode (a cross-origin iframe with a strict CSP), not something bolted on after the fact. See [andbox#14](https://github.com/johnhenry/andbox/issues/14).
- **The Service Worker does not control the very first navigation into its scope.** A page/iframe navigation into `scope` that happens *before* the registration has finished activating is a normal, unintercepted network request -- Service Workers never retroactively intercept a request that already went out. `createSandbox({ mode: 'service-worker' })`'s returned promise only resolves once the registration is active (its generated script also calls `clients.claim()` on activate, which helps *already-open* clients but not fresh navigations); the documented, load-bearing contract is: don't navigate anything into `scope` until that promise resolves. Do that and every request is intercepted from the first byte, because the registration already matches `scope` before the navigation request is made. See [andbox#14](https://github.com/johnhenry/andbox/issues/14).

If you need to run untrusted/adversarial code, use `createSandbox({ untrusted: true })` (`mode: 'wasm'`) and, for hostile multi-tenant workloads, pair it with OS-level isolation (a separate process/container with its own network and filesystem restrictions) or use a purpose-built sandboxing runtime. Capability gating and rate limits here are for organizing and throttling code you already trust, not for containing code you don't.

## Threat model by mode

What each mode is built to stop, and what it is not. "Hostile" means code actively trying to escape or abuse the host.

| | `worker` / `node-worker` | `wasm` | `iframe` |
|---|---|---|---|
| **Runs in** | The Worker's own JS engine (`new Function`) | QuickJS-ng compiled to WebAssembly, inside the Worker / worker thread | The browser's JS engine, in a sandboxed opaque-origin frame (`new Function` in the frame's realm) |
| **Reaching `fetch`, `WebSocket`, `importScripts`, `indexedDB`, `postMessage`** | Removed from the global scope by the prelude (0.1.0), so not reachable by name or via `globalThis`/`eval`/`Function`; with `network`, `fetch` is a shim that goes through your host function. Deny-list hardening only: `import()`, timing channels and (Node) `process`/`require` remain. | Not possible. The engine has no such globals, and `constructor`/`eval`/`Function` chains only reach the guest realm. | Available, as the frame's own (`null`-origin) APIs (with `network`, `fetch` is the host-backed shim); restrict the network with `csp`. Your page, cookies and storage are not reachable (`SecurityError`). |
| **Forging protocol messages to the host** | `postMessage`/`self` are removed; ids are random UUIDs and each `result` must echo a per-evaluate nonce. | Not possible. The guest has no `postMessage` or `self`. | Only over its own `MessagePort`, with the same random ids and nonce; the host accepts nothing else from the frame. |
| **`sandboxImport` of arbitrary URLs / Node builtins** | Remote `http(s)` URLs allowed unless `allowedImportHosts` is provided (then only listed hosts; `[]` denies all); the raw `import()` operator is still unrestricted (browser), and Node builtins are blocked only with `nodeWorker.permissions` (Node). | Refused: only virtual modules resolve; no URL is fetched. | As worker mode (`allowedImportHosts` governs `sandboxImport()` only); requests are cross-origin from `null`. `csp` can restrict `import()` too. |
| **Prototype-chain names via `host.call`** | Closed by the capability gate (`Object.create(null)`). | Same gate, plus the guest never sees host objects. | Same gate; separate realm, so no shared intrinsics. |
| **Infinite loops** | `terminate()` after `timeoutMs`, then a new Worker. | Deterministic `fuel` and a wall-clock `deadlineMs` stop it without a respawn; `terminate()` remains the backstop. | Async hangs: frame removed after `timeoutMs`, then a new frame. Synchronous loops: only where the frame is out of process (desktop Chrome, with no other same-site sandboxed frame alive); elsewhere they freeze the page. |
| **Memory exhaustion** | Browser: nothing but the tab limit. Node: opt-in `nodeWorker.maxMemoryMb`. | Guest heap cap plus a hard cap on the engine's linear memory. | Nothing but the browser's per-process/tab limit. |
| **Deep recursion** | Engine stack limit of the host JS engine. | `stackBytes`; overflow is a catchable `RangeError`. | Engine stack limit. |
| **Capability abuse** | `gateCapabilities()` rate and size limits (cooperative callers). | Same. | Same. |

**What `wasm` mode does not defend against**

- **Bugs in QuickJS-ng or in the WebAssembly engine.** A memory-safety bug in QuickJS is confined to the module's linear memory, but a bug in the browser's WebAssembly implementation is a browser sandbox escape. Keep browsers and Node updated; pinning the engine version here is a reproducibility choice, not a security update channel.
- **What your capabilities do.** `host.call` is the whole attack surface. A capability that reads any path, fetches any URL, or evals what it is given is an escape hatch by design. Validate arguments host-side, and keep side-effecting capabilities idempotent: a deadline or restart does not undo a host call already in flight ([andbox#8](https://github.com/johnhenry/andbox/issues/8)).
- **Timing and side channels.** QuickJS exposes `Date.now()` and `performance.now()` from the host clock, so a guest can measure time and mount timing attacks on anything the host does in response. andbox does not coarsen those clocks. (QuickJS has no threads, so there is no shared-memory clock on top of them.)
- **Denial of service beyond the limits.** Fuel, memory and deadline bound one `evaluate()`; they do not bound how many you start, how big a capability result is, or CPU time spent *inside* the host while serving a call. Concurrent calls share one thread.
- **The host trusting the result.** Return values are plain JSON from untrusted code; treat them as untrusted input.
- **`nodeWorker.permissions`** is not available in this mode, and a worker thread still shares the process. For hostile code on a server, add OS-level isolation as the [Security model](#security-model) says.

**What `worker` and `node-worker` do not defend against** is the "What is still yours" list in the [Security model](#security-model): they are for code you trust to be well-behaved, not for containing code that is trying to get out. `inline` and `data-uri` provide no isolation at all.

## Family

andbox isn't just a standalone sandbox runtime -- it's the sandboxing engine
that [aimatey](https://github.com/johnhenry/aimatey) middleware wires in for
code-based tool execution.

- **[`@johnhenry/aimatey-middleware-andbox`](https://github.com/johnhenry/aimatey-middleware-andbox)** --
  wires andbox's `createSandbox()` factory (or a pre-built sandbox) into an
  [aimatey](https://github.com/johnhenry/aimatey) bridge middleware, via
  `toolsToCapabilities()` to convert the middleware's `tools`/`executeToolFn`
  into andbox `capabilities`. This package's own [Security model](#security-model)
  is the source of truth for what that capability gate does and does not
  guarantee -- the middleware's Security model section points back here
  rather than repeating it.

## License

MIT
