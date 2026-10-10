# Changelog

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
