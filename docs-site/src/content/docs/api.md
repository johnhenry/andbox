---
title: "API reference"
---

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
