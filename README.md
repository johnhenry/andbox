# andbox

Sandboxed JavaScript runtime with Worker isolation, RPC capabilities, import maps, and timeouts.

andbox runs untrusted JavaScript in an isolated Web Worker with a structured bridge back to the host. Code in the sandbox can call host-provided "capabilities" via RPC, use import-mapped packages, and define virtual modules -- all with configurable rate limits, timeouts, and hard-kill semantics.

Zero dependencies. Uses only Web Workers and standard browser APIs.

## Install

```bash
npm install andbox
```

Or via CDN (no bundler needed):

```js
import { createSandbox } from 'https://esm.sh/andbox';
```

## Quick Start

```js
import { createSandbox } from 'andbox';

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

- **`worker`** (default) -- Full Worker-based isolation with RPC bridge, import maps, virtual modules, and hard-kill timeout semantics.
- **`inline`** -- Same-thread execution via AsyncFunction. Lighter weight, no Worker overhead, but no true isolation. Useful for trusted code.
- **`data-uri`** -- Dynamic `import()` via Blob URL. Module-level isolation without a Worker. Supports globals injection.

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
import { gateCapabilities } from 'andbox';

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

Creates a fetch function that only allows requests to specified hostnames.

```js
import { createNetworkFetch } from 'andbox';

const safeFetch = createNetworkFetch(['api.example.com']);
await safeFetch('https://api.example.com/data'); // OK
await safeFetch('https://evil.com/steal');        // throws
```

### `createStdio()`

Creates an async iterable stream for console output capture.

### `makeDeferred()`, `makeAbortError()`, `makeTimeoutError(ms)`

Promise and error utilities used internally, also available for consumers.

### `makeWorkerSource()`

Returns the Worker script source code as a string (useful for custom Worker setups).

## Isolation Model

Code runs inside a Web Worker created from a Blob URL. The worker has:

- **No DOM access** -- Workers are inherently isolated from the document
- **No direct host references** -- Communication only via `postMessage` RPC
- **Capability gating** -- Host functions are wrapped with rate limits before exposure
- **Hard kill** -- On timeout, the Worker is `terminate()`d and a fresh one is created
- **Virtual modules** -- Modules defined via `defineModule()` are available via `sandboxImport()`

## License

MIT
