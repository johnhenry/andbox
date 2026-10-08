/**
 * Worker source code template for andbox.
 *
 * Returns a string containing the entire Worker script. Zero file dependencies
 * at runtime — critical for CDN usage. The Worker receives its import map and
 * virtual modules via messages, then evaluates user code with RPC access to
 * host capabilities.
 */

/**
 * Generate the Worker source code as a string.
 *
 * The Worker supports the following message types from the host:
 * - `configure`: Set import map, base URL, virtual modules
 * - `defineModule`: Register a virtual module
 * - `evaluate`: Execute user code with timeout + RPC
 * - `dispose`: Clean up and close
 *
 * From the Worker to the host:
 * - `configured`: Ack after configure
 * - `moduleDefined`: Ack after defineModule
 * - `result`: Evaluation result (success or error)
 * - `capabilityCall`: RPC request to host capability
 * - `console`: Forwarded console output
 *
 * @returns {string} The Worker script source code.
 */
export function makeWorkerSource() {
  return `
'use strict';

// ── State ──
let importMap = { imports: {}, scopes: {} };
let baseURL = 'https://andbox.local/';
let allowedImportHosts = [];
const virtualModules = new Map();
// Node mode only: the adapter provides a loader that lets virtual modules
// import each other. Captured once and removed from the global scope.
const nodeVirtual = globalThis.__andboxNodeVirtual;
try { delete globalThis.__andboxNodeVirtual; } catch {}

// ── Worker-global lockdown (andbox#10, hardening only) ──
// Capture what the runtime needs, then remove the ambient network/worker APIs
// so evaluated code does not get them by name, via globalThis, via indirect
// eval or via Function. This is NOT a security boundary: the platform \`import()\`
// operator, Atomics/timing channels and, under Node, \`process\`/\`require\` stay
// reachable. Use mode: 'wasm' (or an OS-level boundary) for hostile code.
const scope = self;
const post = self.postMessage.bind(self);
const closeSelf = typeof self.close === 'function' ? self.close.bind(self) : () => {};
const LOCKED_GLOBALS = [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource',
  'Worker', 'SharedWorker', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel',
  'postMessage', 'self',
];
for (const k of LOCKED_GLOBALS) {
  try { delete globalThis[k]; } catch {}
  if (k in globalThis) {
    try { Object.defineProperty(globalThis, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
}
// Names shadowed lexically for evaluated code as well (covers environments
// where a global could not be deleted).
const SHADOWED = [...LOCKED_GLOBALS, 'window'];

// ── Remote import policy (andbox#7) ──
function assertImportAllowed(href) {
  let u;
  try { u = new URL(href); } catch { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  const host = u.hostname.toLowerCase();
  let baseHost = '';
  try { baseHost = new URL(baseURL).hostname.toLowerCase(); } catch {}
  if (host === baseHost || allowedImportHosts.includes(host)) return;
  throw new Error(\`Import denied: \${host} is not in allowedImportHosts\`);
}

// ── Import Map Resolver (inlined) ──
function resolveWithImportMap(specifier, map, parentURL) {
  if (!map) return null;
  if (parentURL && map.scopes) {
    const scopeKeys = Object.keys(map.scopes)
      .filter(scope => parentURL.startsWith(scope))
      .sort((a, b) => b.length - a.length);
    for (const scope of scopeKeys) {
      const r = matchSpec(specifier, map.scopes[scope]);
      if (r !== null) return r;
    }
  }
  if (map.imports) {
    const r = matchSpec(specifier, map.imports);
    if (r !== null) return r;
  }
  return null;
}

function matchSpec(specifier, mapping) {
  if (mapping[specifier] !== undefined) return mapping[specifier];
  let bestKey = null;
  for (const key of Object.keys(mapping)) {
    if (!key.endsWith('/')) continue;
    if (!specifier.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }
  if (bestKey !== null) return mapping[bestKey] + specifier.slice(bestKey.length);
  return null;
}

// ── sandboxImport() — module loader available to user code ──
async function sandboxImport(specifier) {
  // 1. Virtual module
  if (virtualModules.has(specifier)) {
    if (nodeVirtual) return await nodeVirtual(specifier, virtualModules, importMap);
    const src = virtualModules.get(specifier);
    const blob = new Blob([src], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      return await import(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // 2. Import map resolution
  const mapped = resolveWithImportMap(specifier, importMap);
  if (mapped) {
    return await import(mapped);
  }

  // 3. Relative/absolute URL — resolve against baseURL
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('/')) {
    const resolved = new URL(specifier, baseURL).href;
    assertImportAllowed(resolved);
    return await import(resolved);
  }

  // 4. Absolute URL passthrough
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
    assertImportAllowed(specifier);
    return await import(specifier);
  }

  throw new Error(\`Cannot resolve module: \${specifier}. Add it to importMap or defineModule().\`);
}

// ── Capability RPC ──
const pendingRpc = new Map();

function callCapability(name, args) {
  // Random (not sequential) id -- see host-side evaluate() for rationale:
  // predictable ids let concurrent code guess and forge matching messages.
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    post({ type: 'capabilityCall', id, name, args });
  });
}

// host object exposed to user code
const host = {
  call(name, ...args) {
    return callCapability(name, args);
  },
};

// ── Console Forwarding ──
const originalConsole = { ...console };
function makeForwardingConsole(evalId) {
  return new Proxy(console, {
    get(target, prop) {
      if (['log', 'warn', 'error', 'info', 'debug'].includes(prop)) {
        return (...args) => {
          const serialized = args.map(a => {
            try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
            catch { return String(a); }
          });
          post({ type: 'console', evalId, level: prop, args: serialized });
        };
      }
      return target[prop];
    },
  });
}

// ── Message Handler ──
scope.onmessage = async ({ data: msg }) => {
  switch (msg.type) {
    case 'configure': {
      if (msg.importMap) importMap = msg.importMap;
      if (msg.baseURL) baseURL = msg.baseURL;
      if (Array.isArray(msg.allowedImportHosts)) allowedImportHosts = msg.allowedImportHosts;
      if (msg.virtualModules) {
        for (const [name, src] of Object.entries(msg.virtualModules)) {
          virtualModules.set(name, src);
        }
      }
      post({ type: 'configured' });
      break;
    }

    case 'defineModule': {
      virtualModules.set(msg.name, msg.source);
      post({ type: 'moduleDefined', name: msg.name });
      break;
    }

    case 'evaluate': {
      const fwdConsole = makeForwardingConsole(msg.id);
      try {
        // Wrap in async function for top-level await. The newlines before and
        // after the user code matter: without the trailing one, code ending in
        // a // line comment swallows the closing brace (andbox#23).
        const asyncFn = new Function(
          'sandboxImport', 'host', 'console', ...SHADOWED,
          \`return (async () => {\\n\${msg.code}\\n})();\`
        );
        // \`this\` is a throwaway object so a bare \`this\` is not the global.
        const result = await asyncFn.call(Object.freeze(Object.create(null)), sandboxImport, host, fwdConsole);
        post({ type: 'result', id: msg.id, nonce: msg.nonce, success: true, value: serialize(result) });
      } catch (e) {
        post({
          type: 'result',
          id: msg.id,
          nonce: msg.nonce,
          success: false,
          error: { message: e.message || String(e), name: e.name || 'Error', stack: e.stack },
        });
      }
      break;
    }

    case 'capabilityResult': {
      const pending = pendingRpc.get(msg.id);
      if (pending) {
        pendingRpc.delete(msg.id);
        if (msg.success) {
          pending.resolve(msg.value);
        } else {
          pending.reject(new Error(msg.error || 'Capability call failed'));
        }
      }
      break;
    }

    case 'dispose': {
      // Reject all pending RPCs
      for (const [id, { reject }] of pendingRpc) {
        reject(new Error('Sandbox disposed'));
      }
      pendingRpc.clear();
      closeSelf();
      break;
    }
  }
};

function serialize(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'function') return '[Function]';
  try { JSON.stringify(value); return value; }
  catch { return String(value); }
}
`;
}
