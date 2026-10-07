/**
 * Node virtual filesystem for ES modules.
 *
 * Node's ESM loader cannot `import()` a `blob:` URL, and a `data:` URL has
 * no hierarchical base, so two virtual modules can never import each other
 * relatively through either. This installs in-thread module customization
 * hooks (`module.registerHooks`, synchronous, same thread) that serve an
 * in-memory file table under a hierarchical custom scheme:
 *
 *   andbox-vfs://<namespace>/<path>?v=<version>
 *
 * Relative specifiers (`./b.js`, `../c`) resolve against that base natively,
 * bare specifiers are looked up as other virtual module names and then in a
 * per-namespace import map, and cycles work as they do for real files.
 *
 * `installNodeVfs` is deliberately self-contained (no free variables) so the
 * Node worker adapter can inline `installNodeVfs.toString()` into the thread
 * prelude and share one implementation between the host and the thread.
 *
 * @param {(hooks: object) => unknown} registerHooks `module.registerHooks`
 */
export function installNodeVfs(registerHooks) {
  const KEY = Symbol.for('andbox.vfs');
  if (globalThis[KEY]) return globalThis[KEY];

  const SCHEME = 'andbox-vfs:';
  const spaces = new Map(); // ns -> { files: Map(name -> {v, src}), hist: Map, importMap }
  let counter = 0;
  let denyHostResources = false;

  function space(ns, create) {
    let s = spaces.get(ns);
    if (!s && create) {
      s = { files: new Map(), hist: new Map(), importMap: null };
      spaces.set(ns, s);
    }
    return s;
  }

  function urlFor(ns, name, v) {
    return `andbox-vfs://${ns}/${name.split('/').map(encodeURIComponent).join('/')}?v=${v}`;
  }

  function parse(url) {
    const u = new URL(url);
    return {
      ns: u.host,
      name: decodeURIComponent(u.pathname.slice(1)),
      v: u.searchParams.get('v'),
    };
  }

  function lookup(ns, name) {
    const s = spaces.get(ns);
    if (!s) return null;
    const bare = name.replace(/\.m?js$/, '');
    for (const cand of [name, name + '.js', name + '.mjs', name + '/index.js', bare]) {
      const f = s.files.get(cand);
      if (f) return { name: cand, v: f.v };
    }
    return null;
  }

  function matchSpec(specifier, mapping) {
    if (mapping[specifier] !== undefined) return mapping[specifier];
    let best = null;
    for (const key of Object.keys(mapping)) {
      if (key.endsWith('/') && specifier.startsWith(key) && (best === null || key.length > best.length)) best = key;
    }
    return best === null ? null : mapping[best] + specifier.slice(best.length);
  }

  function mapSpecifier(map, specifier, parentURL) {
    if (!map) return null;
    if (map.scopes) {
      const scopes = Object.keys(map.scopes)
        .filter((k) => parentURL.startsWith(k))
        .sort((a, b) => b.length - a.length);
      for (const k of scopes) {
        const r = matchSpec(specifier, map.scopes[k]);
        if (r !== null) return r;
      }
    }
    return map.imports ? matchSpec(specifier, map.imports) : null;
  }

  function checkDenied(url, specifier) {
    if (denyHostResources && (url.startsWith('node:') || url.startsWith('file:'))) {
      const e = new Error(`Import of '${specifier}' is blocked in a hardened andbox sandbox`);
      e.code = 'ERR_ANDBOX_BLOCKED';
      throw e;
    }
  }

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = context.parentURL;
      if (specifier.startsWith(SCHEME)) {
        const p = parse(specifier);
        const hit = lookup(p.ns, p.name);
        if (!hit) throw new Error(`Cannot find virtual module '${p.name}'`);
        return {
          url: urlFor(p.ns, hit.name, hit.v),
          format: 'module',
          shortCircuit: true,
        };
      }
      if (typeof parent === 'string' && parent.startsWith(SCHEME)) {
        const pp = parse(parent);
        const relative = /^(\.\.?)?\//.test(specifier);
        if (relative) {
          const name = decodeURIComponent(new URL(specifier, parent).pathname.slice(1));
          const hit = lookup(pp.ns, name);
          if (!hit) throw new Error(`Cannot resolve '${specifier}' from virtual module '${pp.name}'`);
          return { url: urlFor(pp.ns, hit.name, hit.v), format: 'module', shortCircuit: true };
        }
        const hit = lookup(pp.ns, specifier);
        if (hit) return { url: urlFor(pp.ns, hit.name, hit.v), format: 'module', shortCircuit: true };
        const mapped = mapSpecifier(spaces.get(pp.ns)?.importMap, specifier, parent);
        if (mapped !== null) {
          checkDenied(mapped, specifier);
          return nextResolve(mapped, context);
        }
      }
      const r = nextResolve(specifier, context);
      checkDenied(r.url, specifier);
      return r;
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(SCHEME)) return nextLoad(url, context);
      const p = parse(url);
      const src = spaces.get(p.ns)?.hist.get(p.name + '\0' + p.v);
      if (src === undefined) throw new Error(`Virtual module '${p.name}' is not available (disposed?)`);
      return { format: 'module', source: src, shortCircuit: true };
    },
  });

  const api = {
    /** Define/replace a file; returns its current URL. Unchanged source keeps its version. */
    define(ns, name, source) {
      const s = space(ns, true);
      const cur = s.files.get(name);
      if (cur && cur.src === source) return urlFor(ns, name, cur.v);
      const v = ++counter;
      s.files.set(name, { v, src: source });
      s.hist.set(name + '\0' + v, source);
      return urlFor(ns, name, v);
    },
    urlOf(ns, name) {
      const f = spaces.get(ns)?.files.get(name);
      return f ? urlFor(ns, name, f.v) : null;
    },
    sourceOf(ns, name) {
      return spaces.get(ns)?.files.get(name)?.src ?? null;
    },
    has: (ns, name) => !!spaces.get(ns)?.files.has(name),
    names: (ns) => [...(spaces.get(ns)?.files.keys() ?? [])],
    setImportMap(ns, map) {
      space(ns, true).importMap = map || null;
    },
    dispose(ns) {
      spaces.delete(ns);
    },
    /** From now on, imports resolving to `node:` or `file:` URLs throw. */
    denyHostResources() {
      denyHostResources = true;
    },
  };
  globalThis[KEY] = api;
  return api;
}

/**
 * The host-thread VFS, installed lazily (and only under Node, via the
 * synchronous `process.getBuiltinModule`, which keeps `node:module` out of
 * bundler graphs). Returns null where hooks are unavailable (browsers).
 */
export function getHostNodeVfs() {
  const registerHooks = globalThis.process?.getBuiltinModule?.('node:module')?.registerHooks;
  return typeof registerHooks === 'function' ? installNodeVfs(registerHooks) : null;
}
