---
title: "andbox"
---

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


## Isolation Model

Code runs inside a Web Worker created from a Blob URL. The worker has:

- **No DOM access** -- Workers are inherently isolated from the document
- **No direct host references** -- Communication only via `postMessage` RPC
- **Capability gating** -- Host functions are wrapped with rate limits before exposure
- **Hard kill** -- On timeout, the Worker is `terminate()`d and a fresh one is created
- **Virtual modules** -- Modules defined via `defineModule()` are available via `sandboxImport()`

## License

MIT
