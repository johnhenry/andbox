# Changelog

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
