# Changelog

## 0.3.1 — console output goes to the call that logged; errors keep the sandbox stack (2026-10-10)

A fix, plus two additive fields. See [#41](https://github.com/johnhenry/andbox/issues/41).

- **Fixed: overlapping `evaluate()` calls got each other's console output.**
  The host swapped one active console handler per call, so while two calls
  were running, output from either went to whichever started last, and a
  call that settled before a newer one could leave its handler in place for
  later calls. The runtime already named the call on every console message;
  the host now routes by it: a call's `onConsole` gets that call's output
  only, and output from a call without one, or that arrives after the call
  settled, goes to the sandbox-level `onConsole`. worker, node-worker,
  iframe and wasm modes. Thread stdio (`captureStdio`) names no call and
  still goes to the newest running call's handler.
- **`evaluate(code, { consoleId })`** (a string or finite number): every
  console handler is called with `this.consoleId` set to the id of the call
  that logged, also for output after the call settled, so callers that run
  several things on one sandbox can credit each line (a notebook's panes,
  say). Attribution, not authentication: the runtime carries the id, so
  sandboxed code holding another call's `console` logs as that call.
  `ConsoleContext` type.
- **`err.sandboxStack`** on a rejected `evaluate()`: the error's stack as the
  sandbox saw it (the evaluated code's frames, line numbers and
  `//# sourceURL=` names), which the worker already sent and the host
  dropped. `err.stack` is unchanged (the host's). `SandboxEvaluationError`
  type.
- Tests: `test/console-attribution.test.mjs` (default worker mode and
  node-worker, under Node) and `test/browser/console-attribution.spec.mjs`
  (browser Worker and iframe, in Chromium, Firefox and WebKit).

## 0.3.0 — bridges, and a Chrome built-in AI bridge (2026-10-10)

Additive; nothing changes unless you pass the new `bridges` option. A minor
bump rather than a patch because it adds a public subpath export
(`@johnhenry/andbox/bridges/chrome-ai`), a new message family in the runtime
protocol and a security-relevant surface that `^0.2.x` installs should not
pick up silently. See [#46](https://github.com/johnhenry/andbox/issues/46).

- **`createSandbox({ bridges })`** (worker, node-worker, iframe): each entry
  becomes a sandbox global that proxies a host API without sharing a host
  object. Async methods with structured-clone arguments and results;
  **handles** to host objects (methods, snapshot props, `destroy()`, a
  per-sandbox `maxHandles`); **streams** that arrive as `ReadableStream`s,
  pulled chunk by chunk, with cancel reaching the host; **abort** through any
  `AbortSignal` in the arguments; **callbacks**: sandbox functions become
  host-side async proxies that run in the sandbox; a **consent hook**
  (`onRequest`, only `true` allows) and `requiresUserActivation` for methods
  that need a page gesture; **budgets**: every method call is a gate entry
  (`policy.capabilities['svc.Session.ask']`), plus `limits` for handles, open
  streams, result size and call time. Everything a runtime held is destroyed
  on the host when it is disposed, restarted or killed. `wasm`, `inline`,
  `data-uri` and `service-worker` throw if given `bridges`.
- **`defineBridge()`** and `DEFAULT_BRIDGE_LIMITS` exports;
  `sandbox.stats().bridges`.
- **`chromeAI()`** from `@johnhenry/andbox/bridges/chrome-ai`, no
  dependencies: `ai.languageModel`, `ai.summarizer`, `ai.writer`,
  `ai.rewriter`, `ai.translator`, `ai.languageDetector`, `ai.proofreader` in
  the sandbox, mirroring Chrome's built-in AI APIs (sessions as handles,
  `promptStreaming()` and friends as streams, `monitor` download progress,
  `measureContextUsage()`/`contextUsage`/`contextWindow` with the legacy
  names where the browser has them, open-loop tool content converted both
  ways). Feature-detected on the host; missing APIs report `'unavailable'`.
  Token budgets (`maxInputTokens`, `maxInputTokensPerCall`) measured before
  the model runs; `create()` reports `requiresUserActivation: 'sticky'` when
  the model must be downloaded. These APIs exist only in Window contexts (not
  Workers; blocked by permissions policy in an opaque-origin iframe), so for
  sandboxed code the bridge is the only route.
- `makeWorkerSource({ bridges })`; without it the generated script is unchanged.
- Docs: README "Bridges", "Chrome AI bridge", Security model items for both.
  Examples 10 (Node, a fake host API) and 11 (browser, Chrome AI with a
  consent prompt; `npm run example:11:headless`). Tests:
  `test/bridges.test.mjs`, `test/chrome-ai-bridge.test.mjs`,
  `test/browser/bridges.spec.mjs` (worker and iframe, a fake `LanguageModel`,
  and a real-API smoke test where the browser has it).

## 0.2.0 — `network` needs `allowedHosts` (2026-10-10)

**Upgrade from `0.1.3` if you use the `network` option.** Since 0.1.3,
`createSandbox({ network: { fetch } })` let the sandbox reach every host your
`fetch` function would fetch: setting `network` meant network access by
default. From 0.2.0 `network.allowedHosts` is required, so the sandbox has no
network unless you say which hosts it may reach. Nothing changes if you do
not use `network`. See [#43](https://github.com/johnhenry/andbox/issues/43); landed in 9e5c3bd ([#45](https://github.com/johnhenry/andbox/pull/45)).

### Can I keep `network: { fetch }` alone? No.

`createSandbox()` throws `network.allowedHosts is required` (synchronously,
before any Worker or frame starts) and the message shows the three forms. Add
one of them:

- `allowedHosts: ['api.example.com']` if you know the hosts,
- `allowedHosts: (url) => myPolicy.allows(url)` if the list changes while the
  sandbox runs (asked for every request and every redirect hop),
- `allowedHosts: '*'` if your `fetch` function already enforces its own
  policy; it then stays the whole policy, exactly as in 0.1.3.

`network: { fetch, allowedHosts: '*' }` behaves exactly like 0.1.3's
`network: { fetch }`.

### Can I keep `network: { allowedHosts: [...] }` as it is? Yes, mostly.

A list keeps 0.1.3's matching (exact hostname, any port, no subdomains) and
still refuses every redirect. New: entries are validated and normalised, so a
list containing an entry that could never match now throws instead of
silently denying, e.g. `'https://api.example.com'`, `'api.example.com:8080'`,
`'*.example.com'`, `'::1'` (write `'[::1]'`) or `['*']` (write `'*'`). IDN
entries are converted to punycode, so `'bücher.example'` now matches.

### What is new

- **`allowedHosts` is required and checked on the host before your `fetch` is
  called.** It is one of: a non-empty list of hostnames; a function
  `(url: URL) => boolean | Promise<boolean>`, asked with a fresh `URL` for
  every request, so an app can change its allowlist at runtime (only `true`
  allows; a thrown error becomes the sandbox's rejection message); or the
  explicit opt-in `'*'` for any http(s) host. `fetch` stays optional and
  defaults to the platform's `fetch` behind the policy. See #43.
- **Redirects, per form.** A list refuses any redirect (unchanged). A function
  policy has andbox follow redirects itself with `redirect: 'manual'`, asking
  the function about each `Location` before requesting it (at most 20 hops,
  Fetch-standard method/body rewriting, `Authorization` dropped on a
  cross-origin hop); where the platform hides the target (a browser's
  `opaqueredirect`), the request fails instead of following blindly. `'*'`
  passes the sandbox's `redirect` mode to your `fetch`, which decides. See #43.
- **Types:** `SandboxNetworkOptions.allowedHosts` is required and typed as
  `readonly string[] | '*' | SandboxHostPolicy`.
- **Tests:** `test/network-fetch.test.mjs` covers the required option, the
  three forms (including a function re-evaluated per request), entry
  validation, and redirect handling against mocks and a real server;
  `test/browser/network-fetch.spec.mjs` adds the same for browser Workers and
  iframe mode, including a real browser redirect (`test/browser/serve.mjs`
  gained `/__redirect`).
- **Docs:** README "Mediated network" (forms, matching rules, redirects, the
  server-side caution that a host function has the server's network
  position), the options table and "Security model".
- **Unchanged:** the standalone `createNetworkFetch()` still allows every host
  when its list is missing or empty; tracked in
  [#44](https://github.com/johnhenry/andbox/issues/44).


## 0.1.3

- **New: `network` option, a host-backed global `fetch`** ([#39](https://github.com/johnhenry/andbox/issues/39)).
  `createSandbox({ network: { fetch(url, init) { ... } } })` installs a global
  `fetch` in the sandbox (worker, node-worker and iframe modes) that sends
  every request to that host function, so libraries imported into the sandbox
  that call the global `fetch` work. The shim refuses non-http(s) URLs, sends
  only the URL, method, header pairs, body and redirect mode, and rebuilds a
  real `Response`; `credentials` is the host's (`network.credentials`,
  default `'omit'`), and `Set-Cookie` never reaches the sandbox. The request
  is the gated capability `fetch`, so `policy.capabilities.fetch` applies, and
  the host side re-validates it as untrusted input.
  `network: { allowedHosts: [...] }` puts `createNetworkFetch()` in front (of
  `network.fetch`, or of the host's own `fetch`). Without the option nothing
  changes: worker modes still have no `fetch`. Throws in `wasm`, `inline`,
  `data-uri` and `service-worker` modes, and together with a capability
  named `fetch`.
- **Limitation:** it narrows `fetch` only. The platform `import()` operator
  (and, in iframe mode, the frame's other network APIs unless `csp` blocks
  them) still reach the network; README "Mediated network" and "Security
  model" have the details. Responses are buffered, not streamed, and aborting
  the sandbox-side signal does not cancel the host request.
- `makeWorkerSource({ networkFetch: true })` returns the runtime with the
  shim; `makeWorkerSource()` output is unchanged.
- **Tests:** `test/network-fetch.test.mjs` (worker_threads) and
  `test/browser/network-fetch.spec.mjs` (browser Worker and iframe mode in
  Chromium, Firefox and WebKit).
- **Docs:** `createNetworkFetch()`'s API entry no longer says it follows
  redirects; it has rejected them since 0.0.1 ([#6](https://github.com/johnhenry/andbox/issues/6)).

## 0.1.2

- **New: `mode: 'iframe'`** ([#10](https://github.com/johnhenry/andbox/issues/10)'s
  cross-origin-iframe option). `createSandbox({ mode: 'iframe' })` runs
  evaluated code in an `<iframe sandbox="allow-scripts" srcdoc>` with no
  `allow-same-origin`: an opaque origin and a separate realm with its own
  `window` and `document`, so the code can render DOM (charts, canvas
  animations, HTML) while the browser keeps it out of your page, cookies and
  storage. Same API and semantics as worker mode (`evaluate`, `host.call`,
  `sandboxImport` with `allowedImportHosts`, `importMap`, console forwarding,
  `timeoutMs`/`AbortSignal` hard-kill with the same `TimeoutError`/`AbortError`);
  the returned sandbox adds `iframe`, the live element (replaced after a
  restart, `null` after `dispose()`). New options: `container`, `html`, `csp`,
  `iframeSandbox` (`'allow-same-origin'` throws unless
  `dangerouslyAllowSameOrigin: true`) and `onFrame`. Browser only.
- **Limitation:** a synchronous infinite loop can only be killed where the
  browser runs the frame out of process (desktop Chrome, and only while no
  other sandboxed frame of your site shares that process); in WebKit/Safari it
  freezes the host page. README "Security model" lists what the origin
  boundary does not cover.
- `makeWorkerSource()` output is unchanged; its runtime is now shared with the
  iframe mode through an internal `makeRuntimeSource()`.
- **Tests:** browser tests with Playwright in Chromium, Firefox and WebKit
  (`npm run test:browser`, also in CI); `examples/09-iframe-browser/`
  (`npm run example:09:headless`).

## 0.1.1

- **Behaviour change: remote imports allowed by default again; pass
  `allowedImportHosts: []` to deny.** `sandboxImport()` of `http(s)` (and
  protocol-relative) specifiers is unrestricted when `allowedImportHosts` is
  not provided (reverting the 0.1.0 default, [#7](https://github.com/johnhenry/andbox/issues/7)).
  When it is provided, only the listed hosts plus `baseURL`'s host pass, and an
  empty list denies all.
- **New: `createSandbox({ untrusted: true })`** selects `mode: 'wasm'`; it
  throws if combined with another `mode` and rejects instead of falling back
  if wasm mode is unavailable.
- **Docs:** README "Security model" now recommends `mode: 'wasm'` for untrusted
  code and lists what remains reachable in `worker`/`node-worker`
  ([#10](https://github.com/johnhenry/andbox/issues/10)).

## 0.1.0

Minor release because two fixes change behaviour (remote `sandboxImport()` is
now deny-by-default; evaluated code no longer sees `self`, `postMessage`,
`fetch` and friends in worker mode).

### Security

Every fix in the 2026-10 security sweep, with impact and affected versions:

| Issue | Severity | Fix | Affected | Fixed in |
|---|---|---|---|---|
| [#5](https://github.com/johnhenry/andbox/issues/5) | Critical | Capability gate bypass via `host.call('constructor', ...)`: null-prototype gate table (0.0.1), `Map`-based own-name lookup, all `Object.prototype` names deny-tested end to end | unscoped `andbox` 0.1.x, `@johnhenry/andbox` 0.0.0 | 0.0.1, hardened 0.0.9 |
| [#6](https://github.com/johnhenry/andbox/issues/6) | High | SSRF via redirect in `createNetworkFetch()`: `redirect: 'manual'`, any redirect rejected, verified against real redirecting servers | same | 0.0.1, verified 0.0.9 |
| [#7](https://github.com/johnhenry/andbox/issues/7) | Medium | `sandboxImport()` loaded arbitrary remote code: remote `http(s)` specifiers (including `//host/...`) are denied unless the host is in the new `allowedImportHosts` option or is `baseURL`'s host | all before 0.1.0 | 0.1.0 |
| [#8](https://github.com/johnhenry/andbox/issues/8) | Medium | Timeout did not cancel in-flight host-side capability effects: capabilities get `this.signal`, aborted when the Worker is terminated (cooperative) | all before 0.0.10 | 0.0.10 |
| [#9](https://github.com/johnhenry/andbox/issues/9) | Low | Forgeable sequential ids: random UUID ids plus a per-evaluate nonce the host checks | all before 0.0.9 | 0.0.9 |
| [#10](https://github.com/johnhenry/andbox/issues/10) | Architectural | Worker globals: `fetch`, `WebSocket`, `Worker`, `importScripts`, `postMessage`, `self`, ... are removed from the global scope and shadowed before evaluated code runs. Partial: a Worker is not a boundary (`import()`, timing channels and, under Node, `process`/`require` remain). Issue stays open; `mode: 'wasm'` is the containing option | all before 0.1.0 | 0.1.0 (partial) |
| [#30](https://github.com/johnhenry/andbox/issues/30) | Stability | A capability finishing after its Worker was killed threw `TypeError` (process-fatal under Node): late results are dropped | all before 0.0.10 | 0.0.10 |

### Changed (behaviour)

- **`sandboxImport('https://...')` is refused by default.** Add the hostname to
  `allowedImportHosts: ['esm.sh']` to restore it. Import-map entries pointing at
  URLs keep working unchanged.
- **Worker mode:** evaluated code no longer has `fetch`, `WebSocket`,
  `WebSocketStream`, `WebTransport`, `EventSource`, `XMLHttpRequest`, `Worker`,
  `SharedWorker`, `importScripts`, `indexedDB`, `caches`, `BroadcastChannel`,
  `postMessage` or `self`, and a bare top-level `this` is no longer the global
  object. Host capabilities (`host.call`) are the way to reach the network.
  Code that needs the old behaviour should use `mode: 'inline'` or do the work
  in a capability.

## 0.0.10

### Security

- **Capability calls get an `AbortSignal` tied to the Worker's lifetime
  ([#8](https://github.com/johnhenry/andbox/issues/8)).** Capabilities are
  invoked with `this = { signal, name }`; the signal aborts when the Worker is
  terminated by a timeout, an aborted `evaluate()`, `dispose()` or a crash.
  Previously a script could start a slow, effectful capability just before its
  timeout and the host-side effect completed regardless, after the caller had
  been told the call timed out. Cancellation is cooperative (a capability that
  ignores the signal still runs); the signal is passed as `this`, not as an
  argument, so existing capabilities are unaffected. Affected: all earlier
  versions. Not covered: `mode: 'wasm'` cooperative deadlines (the Worker
  survives them).

### Fixed

- **A capability finishing after its Worker is gone no longer throws
  ([#30](https://github.com/johnhenry/andbox/issues/30)).** The late result
  (success or failure) is dropped instead of dereferencing a null `worker`
  (uncaught in Node, unhandled rejection in browsers), and it is no longer
  posted into a replacement Worker that never asked for it.

## 0.0.9

### Security

- **Capability lookup is now own-property / `Map` based (hardening of
  [#5](https://github.com/johnhenry/andbox/issues/5)).** The prototype-chain
  bypass itself (`host.call('constructor', ...)`) was closed in 0.0.1 by building
  the gated table with `Object.create(null)`. The host now additionally resolves
  names through a `Map` (`gateCapabilities().lookup(name)`), so non-string names
  and any name not explicitly granted can never resolve, and `policy.capabilities`
  is read with an own-property check. Every `Object.prototype` member name is
  covered by an end-to-end deny test. Affected by the original bypass: 0.1.0 of
  the unscoped `andbox` and `@johnhenry/andbox` 0.0.0.
- **`createNetworkFetch()` redirect handling is covered by tests against real
  redirecting servers (verifies [#6](https://github.com/johnhenry/andbox/issues/6)).**
  Fixed in 0.0.1 (`redirect: 'manual'`, every 3xx rejected, a caller-supplied
  `redirect: 'follow'` cannot re-enable following). New tests confirm the redirect
  target is never contacted. Affected before 0.0.1: allowlisted hosts could bounce
  a request to a non-allowlisted host (SSRF).
- **Unguessable correlation ids plus a per-evaluate nonce
  ([#9](https://github.com/johnhenry/andbox/issues/9)).** Evaluate and capability
  rpc ids are `crypto.randomUUID()`; each `evaluate` also carries a nonce that the
  worker echoes in its `result`, and the host drops a result whose nonce does not
  match. Impact was low (concurrent evaluates on one sandbox could previously
  cross-talk by guessing sequential ids).

## 0.0.8

- **New: `mode: 'wasm'`.** Runs the evaluated code in QuickJS-ng compiled to
  WebAssembly inside the existing Worker (browser) or `worker_thread` (Node),
  so `host.call` is the only authority: no `fetch`, `WebSocket`,
  `importScripts`, `indexedDB`, `postMessage` or `self` exist in the engine,
  and `sandboxImport()`/`import()` resolve only virtual modules. Real limits:
  deterministic `fuel` (interrupt polls), `memoryBytes` (JS heap cap plus a hard
  cap on the engine's linear memory), `stackBytes`, and a wall-clock
  `deadlineMs`; `terminate()` stays the backstop. Failures carry distinct
  codes: `FuelExhaustedError` / `ERR_ANDBOX_FUEL_EXHAUSTED`, `MemoryLimitError`
  / `ERR_ANDBOX_MEMORY_LIMIT`, `TimeoutError` / `ERR_ANDBOX_DEADLINE`,
  `EngineError` / `ERR_ANDBOX_ENGINE`; the Worker survives all of them.
  Capability gating, rate limits, `onConsole`, `defineModule` and the
  `evaluate()` result shape are shared with worker mode. `stats()` adds
  `fuelUsed`, `peakMemoryBytes` and `totalFuelUsed`. Closes
  [#21](https://github.com/johnhenry/andbox/issues/21).
- The engine is an **optional** peer dependency pinned to exact versions
  (`quickjs-emscripten-core@0.32.0`,
  `@jitl/quickjs-ng-wasmfile-release-sync@0.32.0`). Missing packages give
  `ERR_ANDBOX_ENGINE_MISSING` with the install command; the default mode and the
  main entry are unchanged. For browsers without a CDN, bundle
  `@johnhenry/andbox/wasm-engine` and serve the `.wasm` yourself, then pass
  `engineURL` / `wasmURL` (or the import map entries
  `@johnhenry/andbox/wasm-engine` and `@johnhenry/andbox/wasm`).
  `examples/08-wasm-browser/` is a working recipe, verified in headless Chrome.
- README: a `mode: 'wasm'` section and a per-mode threat model.
- Startup failures of a Worker (including an engine that cannot load) now reject
  `createSandbox()` instead of hanging it, and the thread is not leaked.
- The sync QuickJS variant is used (not the asyncify one): host calls are
  promise-based, so concurrent `host.call`s work and the `.wasm` is half the
  size (528 KB vs 1.2 MB).
- Release numbering: still `0.0.x`, as for every feature since the scoped
  restart. The old unscoped `andbox` already used the `v0.1.x` git tags.

## 0.0.7

- **Fixed:** `evaluate()` code whose last line ends in a `//` comment (for
  example `return x // done`) no longer fails with
  `SyntaxError: Unexpected end of input`. The worker wrapper now puts a newline
  before the closing brace so the comment cannot swallow it. Regression tests
  cover the three cases from the issue plus inline and data-uri modes. Closes
  [#23](https://github.com/johnhenry/andbox/issues/23).

## 0.0.6

Closes the remaining Node-mode gaps from 0.0.4/0.0.5.

- **Virtual modules import each other under Node.** Worker-thread virtual
  modules (`defineModule`/`sandboxImport`) are now served by an in-thread
  `module.registerHooks` loader (`andbox-vfs://` URLs) instead of per-call
  `data:` URLs, so they support relative imports (`./b`, `../c.js`), bare-name
  imports, the sandbox `importMap`, cycles, and extensionless/`index.js`
  lookup. Behaviour note: modules are cached per definition, so repeated
  `sandboxImport(name)` returns the same instance until redefined.
- **`createVirtualModuleRegistry()` works under Node.** Its URLs are now
  importable (`andbox-vfs:` instead of un-importable `blob:`), with relative
  imports between the files. New `source(path)` method and
  `options.backend` (`'auto' | 'blob' | 'node'`); the browser path is
  unchanged.
- **Behaviour change (pre-1.0):** an unknown `mode` now throws
  `Unknown sandbox mode '...'. Supported modes: ...` instead of silently
  using worker mode. `mode: ''` also throws.
- **Bundler coverage:** real browser-target smoke tests for webpack 5 and
  Vite (devDependencies) alongside the existing esbuild test.
- **Opt-in hardening: `nodeWorker`.** `nodeWorker.permissions: true` spawns
  the thread with Node's permission model (`--permission`), an isolated `env`,
  a default 256 MB heap cap, stripped `process` escapes (`binding`,
  `getBuiltinModule`, `dlopen`, `kill`, ...), blocked `node:`/`file:` imports
  and captured stdio. Also `env`, `maxMemoryMb`, `resourceLimits`, `execArgv`,
  `captureStdio`. A thread that dies (e.g. out of memory) is replaced on the
  next call. The README now states plainly that a worker thread is not a
  security boundary and what the hardening does and does not prevent.
- **`unref` option** (default `false`): lets the process exit while the
  sandbox is idle. Without it a live sandbox keeps the process alive until
  `dispose()` (confirmed and now tested).

## 0.0.5

- The Node-mode `import('node:worker_threads')` now uses a non-literal
  specifier with `@vite-ignore` / `webpackIgnore` hints, so browser bundlers
  (webpack 5 failed on the unresolvable `node:` scheme; Vite warned) no
  longer try to resolve it. A new test bundles `src/index.mjs` for the
  browser with esbuild and asserts no `node:` resolution error.

## 0.0.4

- Added a **Node mode**: `createSandbox()` now works under Node with no
  `Worker` shim. When there is no global `Worker` and the runtime is Node,
  the default `worker` mode runs the same worker script on
  `node:worker_threads` (source passed with `{ eval: true }`, no blob: URLs;
  `terminate()`, timeouts, restarts, RPC and error propagation behave as in
  the browser). `mode: 'node-worker'` forces it, and the new `workerFactory`
  option plus exported `createNodeWorkerFactory()` let hosts supply their
  own. Virtual modules (`defineModule`/`sandboxImport`) use `data:` URLs
  inside the thread. The browser path is unchanged. Closes
  [#22](https://github.com/johnhenry/andbox/issues/22).
- `mode: 'data-uri'` now works under Node (uses a `data:` URL, since Node
  cannot `import()` a `blob:` URL).
- Fixed `mode: 'data-uri'` with non-empty `globals`: the generated preamble
  read `globalThis.__andbox_globals__` after the wrapper had already deleted
  it, so every such call threw. It now destructures from the captured value.
- CI and publish now run on Node 26 (matching `engines`).

## 0.0.3

- Fixed the package's `exports` map: it was a bare `"./src/index.mjs"`
  string with no `types` condition and no top-level `types` field, even
  though `src/index.d.ts` ships in the package. TypeScript's `Bundler` /
  `Node16`/`Node20` module resolution only consults the `exports` map when
  present and ignores sibling `.d.ts` files, so
  `import { createSandbox } from '@johnhenry/andbox'` reported TS7016
  despite the declarations existing right there. Added a top-level `types`
  field and a `types` condition in the `exports` map (there is only the
  one `.` entry). Closes [#19](https://github.com/johnhenry/andbox/issues/19).

## 0.0.2

- Added `createVirtualModuleRegistry()`: takes a `path → source` map, mints
  one real `blob:` URL per entry (generalizing the single-file
  `Blob`/`createObjectURL` pattern `data-uri` mode already used), and
  resolves module specifiers across the tree -- import-map resolution via
  `resolveWithImportMap()` first, then a new relative-path (`./`, `../`)
  fallback against the known file table, then `null` for anything
  genuinely external. A registered path containing `#`/`?` used to be
  parsed as the synthetic base URL's own fragment/query delimiter during
  that relative-path resolution, silently truncating everything after it
  (found in review); each path segment is now percent-encoded before
  resolution. Closes [#13](https://github.com/johnhenry/andbox/issues/13).
- Added a fourth `mode: 'service-worker'`: registers a Service Worker
  backing a `path → content` map with real, same-origin, HTTP-shaped
  fetch/navigation semantics, for hosting a small virtual multi-file site
  rather than executing JS in isolation. Can optionally pull served
  content from a `createVirtualModuleRegistry()` instance instead of a
  second path table. Documents (and handles, via `clients.claim()` plus a
  "don't navigate into scope until registration is active" contract) the
  Service-Worker-doesn't-control-the-first-navigation gotcha, and is
  explicit in the README that this mode does not provide isolation by
  merely existing -- real isolation needs a genuinely separate origin, same
  framing as the existing Security model section already uses for `worker`
  mode. The registration-activation wait originally only listened for
  `'activated'`, so a registration that instead became `'redundant'` (its
  install/activate threw, or it failed to parse) hung forever with no
  timeout (found in review); it now rejects on `'redundant'` and is bounded
  by `timeoutMs` (defaults to `DEFAULT_TIMEOUT_MS`) as defense in depth.
  Closes [#14](https://github.com/johnhenry/andbox/issues/14).

## 0.0.1

First real publish under the `@johnhenry` scope -- `0.0.0` below was never
actually published (the publish workflow only triggers on a `v*` tag push,
and none was cut after the scope rename, despite two real merged fixes
landing since then). Includes both:

- Closed a capability-gate bypass: `host.call('constructor', ...)` could
  walk the prototype chain to the real global `Object` constructor,
  escaping the rate-limit/allowlist wrapper entirely. Fixed by building the
  gated object with `Object.create(null)`.
- Closed an SSRF-via-redirect gap in `createNetworkFetch()`: the hostname
  allowlist was checked against the request URL, not the final response
  URL, so an allowlisted host could redirect a request to a
  non-allowlisted one. Fixed by fetching with `redirect: 'manual'` and
  rejecting any redirect response outright.

## 0.0.0 (2026-08-25)

Republished as `@johnhenry/andbox`, restarting the version line at `0.0.0`.
Previously published as `andbox@0.1.1` (unscoped). No functional changes.

## 0.1.0 (2026-03-15)

Initial release.

- `createSandbox()` with three execution modes: Worker, inline, and data-uri
- Worker-based isolation with RPC bridge for host capability calls
- Import map resolution (bare specifiers, prefix matches, scopes)
- Virtual module definitions via `defineModule()` / `sandboxImport()`
- Timeout with hard kill and automatic Worker restart
- Console forwarding from sandbox to host
- Capability gating with global and per-capability rate limits
- `createNetworkFetch()` for hostname-allowlisted fetch
- `createStdio()` async iterable streams
- TypeScript type definitions (`index.d.ts`)
