# andbox

A separate-context JavaScript runtime with Worker isolation, RPC capabilities, import maps, and timeouts.

andbox runs JavaScript in a dedicated Web Worker with a structured bridge back to the host. Code in that Worker can call host-provided "capabilities" via RPC, use import-mapped packages, and define virtual modules -- all with configurable rate limits, timeouts, and hard-kill semantics.

**andbox's job is running code in its own context with a clean RPC surface, not containing adversarial code.** The Worker boundary keeps well-behaved code from touching the DOM or host globals by accident, and gives you rate limits, timeouts, and a kill switch for code you trust but don't want to block on or grant unrestricted access to. It is **not** a security sandbox: code that specifically tries to escape can reach `fetch`, `WebSocket`, `Worker`, and other Worker-global APIs directly, regardless of what capabilities you grant. See [Security model](#security-model) before using andbox to run code you don't trust.

Zero dependencies. Uses only Web Workers and standard browser APIs.

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

andbox supports three execution modes:

- **`worker`** (default) -- Runs in a dedicated Worker with an RPC bridge, import maps, virtual modules, and hard-kill timeout semantics. See [Security model](#security-model) for what this does and doesn't protect against.
- **`inline`** -- Same-thread execution via AsyncFunction. Lighter weight, no Worker overhead, no isolation at all -- code runs with full access to the calling context. Only for code you already trust.
- **`data-uri`** -- Dynamic `import()` via Blob URL. Module-level separation without a Worker. Supports globals injection.

```js
// Inline mode (no Worker)
const inline = createSandbox({ mode: 'inline', globals: { math: Math } });
const result = await inline.execute('return math.sqrt(16)');

// Data-URI mode
const dataUri = createSandbox({ mode: 'data-uri', globals: { x: 42 } });
const result = await dataUri.execute('print(x)');
```

## API

### `createSandbox(options?)`

Creates a new sandboxed runtime. Returns a promise (Worker mode) or object (inline/data-uri mode).

**Options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mode` | `'worker' \| 'inline' \| 'data-uri'` | `'worker'` | Execution mode |
| `importMap` | `{ imports?, scopes? }` | `{}` | Import map for package resolution (Worker mode) |
| `capabilities` | `Record<string, Function>` | `{}` | Host functions callable via `host.call()` (Worker mode) |
| `defaultTimeoutMs` | `number` | `30000` | Default timeout for `evaluate()` |
| `baseURL` | `string` | `location.href` | Base URL for relative imports |
| `policy` | `GatePolicy` | -- | Rate limiting policy |
| `onConsole` | `(level, ...args) => void` | -- | Console output handler |
| `globals` | `Record<string, any>` | `{}` | Global variables (inline/data-uri modes) |

**Returns (Worker mode):** `Promise<{ evaluate, defineModule, dispose, stats, isDisposed }>`

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

Terminates the Worker and rejects all pending evaluations.

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

### `createNetworkFetch(allowedHosts?, fetchFn?)`

Creates a fetch function that checks the request hostname against an allowlist before calling through. Useful for keeping cooperative code pointed at the hosts you intend -- **not redirect-safe** (see [Security model](#security-model)): an allowlisted host that responds with a redirect is followed without re-checking the final URL.

```js
import { createNetworkFetch } from '@johnhenry/andbox';

const gatedFetch = createNetworkFetch(['api.example.com']);
await gatedFetch('https://api.example.com/data'); // OK
await gatedFetch('https://evil.com/steal');        // throws
```

### `createStdio()`

Creates an async iterable stream for console output capture.

### `makeDeferred()`, `makeAbortError()`, `makeTimeoutError(ms)`

Promise and error utilities used internally, also available for consumers.

### `makeWorkerSource()`

Returns the Worker script source code as a string (useful for custom Worker setups).

## Execution model

Code runs inside a Web Worker created from a Blob URL. This gets you, for free, against code that isn't specifically trying to defeat it:

- **No DOM access** -- Workers are inherently isolated from the document
- **No direct host object references** -- only what's explicitly passed in (capabilities, globals, import map entries) is reachable, so ordinary code can't accidentally touch host-side state
- **Hard kill** -- on timeout, the Worker is `terminate()`d and a fresh one is created for the next call
- **Virtual modules** -- modules defined via `defineModule()` are available via `sandboxImport()`
- **Capability rate limits** -- `gateCapabilities()` caps calls/concurrency/payload size per capability, for cooperative callers

## Security model

andbox is **not** a boundary against code that is actively trying to escape it. If you're running code you don't fully trust, read this section -- every item below is a confirmed way sandboxed code can act outside what `capabilities`/`policy`/`createNetworkFetch` appear to allow:

- **Worker-global APIs are directly reachable, regardless of `capabilities`.** Sandboxed code executes in a real Worker global scope, so `fetch`, `WebSocket`, `Worker` (nested workers), `importScripts`, `indexedDB`, and `self.postMessage` are all callable directly -- omitting a `fetch` capability does not block network access. This is fundamental to how `Function`-based evaluation works and isn't fixable without a different execution strategy (e.g. a cross-origin iframe with a strict CSP, or a Realms/Compartments-based approach). See [andbox#10](https://github.com/johnhenry/andbox/issues/10).
- **`sandboxImport()` will load and execute an arbitrary remote URL.** Any `http(s)://` specifier is passed straight to `import()` with no allowlist, independent of any network policy configured for capabilities. See [andbox#7](https://github.com/johnhenry/andbox/issues/7).
- **A timeout stops message delivery, not in-flight host-side effects.** If a capability call with a real side effect (a write, an API call) is in flight when the timeout fires, that side effect still completes on the host even though the Worker is killed. Capabilities with real side effects should be designed to be idempotent and/or cancellable via `AbortSignal`. See [andbox#8](https://github.com/johnhenry/andbox/issues/8).

Fixed as of this audit (kept here for history -- see the linked issues for details):

- ~~`gateCapabilities()`'s check could be bypassed via the prototype chain~~ (`host.call('constructor', ...)` resolved through `Object.prototype` to the real global `Object` constructor). Fixed by building the gated object with `Object.create(null)`. See [andbox#5](https://github.com/johnhenry/andbox/issues/5).
- ~~`createNetworkFetch()`'s allowlist was not redirect-safe~~ (it checked the request hostname before the fetch, not the final response URL). Fixed by fetching with `redirect: 'manual'` and rejecting any redirect response outright. See [andbox#6](https://github.com/johnhenry/andbox/issues/6).

If you need to run untrusted/adversarial code safely, andbox alone is not sufficient -- pair it with OS-level isolation (a separate process/container with its own network and filesystem restrictions) or use a purpose-built sandboxing runtime. Capability gating and rate limits here are for organizing and throttling code you already trust, not for containing code you don't.

## License

MIT
