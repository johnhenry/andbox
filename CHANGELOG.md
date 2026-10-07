# Changelog

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
