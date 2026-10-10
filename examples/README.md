# andbox examples

Runnable, self-verifying examples. Each one asserts the behavior it demonstrates and exits 0 on success.

| Example | Demonstrates |
| --- | --- |
| [`01-untrusted-code-runs-isolated.mjs`](./01-untrusted-code-runs-isolated.mjs) | Untrusted code sees only the globals you inject, its output and result are captured, and its crashes are contained instead of crashing the host. |
| [`02-capability-limits-cut-off-abuse.mjs`](./02-capability-limits-cut-off-abuse.mjs) | `gateCapabilities()` enforces global/per-capability call caps, per-call argument byte caps, and concurrency caps on exposed host functions. |
| [`03-network-allowlist-blocks-unapproved-hosts.mjs`](./03-network-allowlist-blocks-unapproved-hosts.mjs) | `createNetworkFetch()` allows only allowlisted hostnames — other hosts, subdomains of allowed hosts, and malformed URLs are denied before any network I/O. |
| [`04-runaway-code-gets-timed-out.mjs`](./04-runaway-code-gets-timed-out.mjs) | Code that never finishes is cut off by the execution timeout with a clean error; the host and sandbox remain usable. |
| [`05-virtual-module-registry-resolves-a-multi-file-tree.mjs`](./05-virtual-module-registry-resolves-a-multi-file-tree.mjs) | `createVirtualModuleRegistry()` mints a real `blob:` URL per file and resolves specifiers across a multi-file tree — import-map matches first, then a relative-path (`./`, `../`) fallback against the known file table, then `null` for anything genuinely external. |
| [`06-service-worker-mode/`](./06-service-worker-mode/) | `createSandbox({ mode: 'service-worker' })` registers a Service Worker backed by an in-memory `path → content` map; an iframe navigates into its scope with real HTTP-shaped semantics — no `blob:` URL, no content rewriting. **Not** part of `npm run examples` — see below. |
| [`07-wasm-mode-contains-hostile-code.mjs`](./07-wasm-mode-contains-hostile-code.mjs) | `createSandbox({ mode: 'wasm' })` runs code in QuickJS compiled to WebAssembly: no `fetch`/`process`/Worker globals, `host.call` as the only authority, deterministic fuel, a memory cap and a deadline, each with its own error code. Needs the optional engine packages (devDependencies here). |
| [`08-wasm-browser/`](./08-wasm-browser/) | The same wasm mode in a real browser Worker, booted from same-origin engine assets (no CDN): `build.mjs` produces them, `serve.mjs` serves them, `run-headless.mjs` drives headless Chrome through the checks (`npm run example:08:headless`). **Not** part of `npm run examples` — it needs a browser. |
| [`09-iframe-browser/`](./09-iframe-browser/) | `createSandbox({ mode: 'iframe' })`: two notebook-style panes, each a sandboxed opaque-origin `<iframe>` mounted in the page, draw a canvas chart and run a `requestAnimationFrame` animation in their own document, read host data only through `host.call`, cannot read the page or its storage, and come back in a fresh frame after a timeout. `run-headless.mjs` drives headless Chromium through it with Playwright (`npm run example:09:headless`). **Not** part of `npm run examples` — it needs a browser. |

| [`10-bridges-share-a-host-api.mjs`](./10-bridges-share-a-host-api.mjs) | `createSandbox({ bridges })` gives sandboxed code a global that proxies a host API (an in-memory notebook service) without handing over a host object: an opaque handle with methods and props, a pulled stream, an `AbortSignal` that aborts the host call, a sandbox function the host calls back, a call the consent hook (`onRequest`) refuses, gate limits by method name, and every handle the sandbox still holds destroyed on the host at `dispose()`. Runs under plain Node (worker thread). |
| [`11-chrome-ai-browser/`](./11-chrome-ai-browser/) | The Chrome built-in AI bridge (`@johnhenry/andbox/bridges/chrome-ai`): a Worker sandbox prompts Chrome's on-device model through the page, with a consent prompt whose click also provides the user activation a model download needs, download progress via `monitor`, streaming, and a token budget. Uses the real `LanguageModel` when the browser has it, otherwise (or with `?fake`) the test fake. `run-headless.mjs` drives headless Chromium through the fake (`npm run example:11:headless`). **Not** part of `npm run examples` — it needs a browser. |

## Running

```sh
npm run examples      # run all in sequence (01-05, 07 and 10 -- see the notes on 06, 08, 09 and 11 below)
npm run example:01    # run one (also :02, :03, :04, :05, :07, :10)
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

- **`mode: 'iframe'`** needs a DOM and a real sandboxed `<iframe>`; Node has neither. Example 09 is a page plus a Playwright runner instead of a plain-Node script, like 08. Its behaviour is covered in Chromium, Firefox and WebKit by `test/browser/iframe-mode.spec.mjs` (`npm run test:browser`); the Node-side parts (option validation, the generated `srcdoc`) by `test/iframe-mode.test.mjs`.
- **Example 10 (`bridges`)** runs the sandbox in a Node worker thread (`node-worker`, selected automatically), so the bridge protocol, handles, streams and callbacks run for real under plain Node. **Example 11** needs a browser: Chrome's built-in AI exists only in Window contexts, which is the point of bridging it.
- **`mode: 'service-worker'`** needs `navigator.serviceWorker`, which does not exist in Node at all — not even partially, unlike `Blob`/`URL.createObjectURL()` above. Example 06 is a small static-site demo (`serve.mjs` + `index.html` + `main.mjs`) instead of a plain-Node script: run `node examples/06-service-worker-mode/serve.mjs` and open the printed URL in a real browser (see `examples/06-service-worker-mode/README.md`). It is **not** wired into `npm run examples` or CI's examples smoke test, since it can't run headlessly there — this exception is intentional, not an oversight. The pure request-matching/response-synthesis logic the generated Service Worker script uses (`resolveServiceWorkerResponse()`) is factored out into its own module and does get full Node coverage in `test/service-worker-response.test.mjs`, the same way example 05's registry logic does.
