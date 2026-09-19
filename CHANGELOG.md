# Changelog

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
