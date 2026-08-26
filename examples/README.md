# andbox examples

Runnable, self-verifying examples. Each one asserts the behavior it demonstrates and exits 0 on success.

| Example | Demonstrates |
| --- | --- |
| [`01-untrusted-code-runs-isolated.mjs`](./01-untrusted-code-runs-isolated.mjs) | Untrusted code sees only the globals you inject, its output and result are captured, and its crashes are contained instead of crashing the host. |
| [`02-capability-limits-cut-off-abuse.mjs`](./02-capability-limits-cut-off-abuse.mjs) | `gateCapabilities()` enforces global/per-capability call caps, per-call argument byte caps, and concurrency caps on exposed host functions. |
| [`03-network-allowlist-blocks-unapproved-hosts.mjs`](./03-network-allowlist-blocks-unapproved-hosts.mjs) | `createNetworkFetch()` allows only allowlisted hostnames — other hosts, subdomains of allowed hosts, and malformed URLs are denied before any network I/O. |
| [`04-runaway-code-gets-timed-out.mjs`](./04-runaway-code-gets-timed-out.mjs) | Code that never finishes is cut off by the execution timeout with a clean error; the host and sandbox remain usable. |

## Running

```sh
npm run examples      # run all in sequence
npm run example:01    # run one (also :02, :03, :04)
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
