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
const virtualModules = new Map();
let evalSeq = 0;

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
    return await import(resolved);
  }

  // 4. Absolute URL passthrough
  if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
    return await import(specifier);
  }

  throw new Error(\`Cannot resolve module: \${specifier}. Add it to importMap or defineModule().\`);
}

// ── Capability RPC ──
let rpcSeq = 0;
const pendingRpc = new Map();

function callCapability(name, args) {
  const id = ++rpcSeq;
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    self.postMessage({ type: 'capabilityCall', id, name, args });
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
          self.postMessage({ type: 'console', evalId, level: prop, args: serialized });
        };
      }
      return target[prop];
    },
  });
}

// ── Message Handler ──
self.onmessage = async ({ data: msg }) => {
  switch (msg.type) {
    case 'configure': {
      if (msg.importMap) importMap = msg.importMap;
      if (msg.baseURL) baseURL = msg.baseURL;
      if (msg.virtualModules) {
        for (const [name, src] of Object.entries(msg.virtualModules)) {
          virtualModules.set(name, src);
        }
      }
      self.postMessage({ type: 'configured' });
      break;
    }

    case 'defineModule': {
      virtualModules.set(msg.name, msg.source);
      self.postMessage({ type: 'moduleDefined', name: msg.name });
      break;
    }

    case 'evaluate': {
      const evalId = ++evalSeq;
      const fwdConsole = makeForwardingConsole(evalId);
      try {
        // Wrap in async function for top-level await
        const asyncFn = new Function(
          'sandboxImport', 'host', 'console',
          \`return (async () => { \${msg.code} })();\`
        );
        const result = await asyncFn(sandboxImport, host, fwdConsole);
        self.postMessage({ type: 'result', id: msg.id, success: true, value: serialize(result) });
      } catch (e) {
        self.postMessage({
          type: 'result',
          id: msg.id,
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
      self.close();
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
