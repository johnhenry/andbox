# andbox examples

Runnable, self-verifying examples. Each one asserts the behavior it demonstrates and exits 0 on success.

| Example | Demonstrates |
| --- | --- |
| [`01-untrusted-code-runs-isolated.mjs`](./01-untrusted-code-runs-isolated.mjs) | Untrusted code sees only the globals you inject, its output and result are captured, and its crashes are contained instead of crashing the host. |
| [`02-capability-limits-cut-off-abuse.mjs`](./02-capability-limits-cut-off-abuse.mjs) | `gateCapabilities()` enforces global/per-capability call caps, per-call argument byte caps, and concurrency caps on exposed host functions. |
| [`03-network-allowlist-blocks-unapproved-hosts.mjs`](./03-network-allowlist-blocks-unapproved-hosts.mjs) | `createNetworkFetch()` allows only allowlisted hostnames — other hosts, subdomains of allowed hosts, and malformed URLs are denied before any network I/O. |
| [`04-runaway-code-gets-timed-out.mjs`](./04-runaway-code-gets-timed-out.mjs) | Code that never finishes is cut off by the execution timeout with a clean error; the host and sandbox remain usable. |
| [`05-virtual-module-registry-resolves-a-multi-file-tree.mjs`](./05-virtual-module-registry-resolves-a-multi-file-tree.mjs) | `createVirtualModuleRegistry()` mints a real `blob:` URL per file and resolves specifiers across a multi-file tree — import-map matches first, then a relative-path (`./`, `../`) fallback against the known file table, then `null` for anything genuinely external. |

## Running

```sh
npm run examples      # run all in sequence
npm run example:01    # run one (also :02, :03, :04, :05)
# or directly:
node examples/01-untrusted-code-runs-isolated.mjs
```

## Runtime requirements (honest edition)

These examples run under **plain Node >= 24** (`node examples/...`), no browser needed. To make that possible they use the parts of andbox that don't require a Web Worker:

- `createSandbox({ mode: 'inline' })` — same-thread `AsyncFunction` isolation (examples 01 and 04).
- `gateCapabilities()` and `createNetworkFetch()` — pure host-side logic (examples 02 and 03).

What they deliberately do **not** cover, and why:

- **`mode: 'worker'` (the default)** needs a browser-style `Worker` global plus Blob URLs. Node exposes `worker_threads`, not the Web `Worker` API, so worker mode — and its strongest guarantee, the **hard kill** (`worker.terminate()` + restart on timeout, the only reliable way to stop a busy-spinning infinite loop) — is browser-only. Example 04 demonstrates the timeout contract in inline mode and documents this difference. This mirrors the test suite: `test/sandbox.test.mjs` notes the worker-mode tests are browser-only, and Node CI covers the pure logic.
- **`mode: 'data-uri'`** uses `import()` of a `blob:` URL, which Node's ESM loader rejects (`file`, `data`, and `node` schemes only), so it is also browser-only.

Inline mode is convenient for demos and trusted-ish plugins, but it shares the host thread and realm — for genuinely hostile code in production, use worker mode in a browser context.

`createVirtualModuleRegistry()` (example 05) sits in between: `Blob` and `URL.createObjectURL()`/`revokeObjectURL()` are real Node >= 24 globals, so the registry's blob creation, path-table bookkeeping, and specifier resolution run and get verified for real under plain Node — including fetching the real blob content to prove it matches. What still doesn't work under Node is `import()`-ing those `blob:` URLs, for the same ESM-loader-scheme reason as `data-uri` mode above; that part needs a browser.
