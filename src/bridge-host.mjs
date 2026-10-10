/**
 * Bridges -- the host side of `createSandbox({ bridges })` (andbox#46).
 *
 * A bridge shares a host API surface with sandboxed code without sharing a
 * single host object: the sandbox gets a global (built by
 * `src/bridge-client.mjs` from a JSON manifest) whose methods send
 * structured-clone messages to the functions in the bridge definition. Host
 * objects stay on the host and are referenced by opaque handle ids; streams
 * are pulled chunk by chunk; sandbox functions in arguments become async
 * host-side proxies that call back into the sandbox.
 *
 * `normalizeBridges()` validates the definitions (before a Worker starts);
 * `createBridgeHost()` is created once per sandbox (state and budgets live as
 * long as the sandbox); `host.openSession(post)` once per Worker/frame: a
 * session owns that runtime's handles, streams and callbacks and destroys all
 * of them when `close()` is called (dispose, timeout, abort, crash).
 */

const MARK = '__andbox_bridge__';
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const MAX_DEPTH = 64;
const MAX_ID_LENGTH = 128;

/** Default per-sandbox limits of one bridge (0 = unlimited). */
export const DEFAULT_BRIDGE_LIMITS = Object.freeze({
  /** Live handles at a time. */
  maxHandles: 32,
  /** Open streams at a time. */
  maxStreams: 8,
  /** Approximate size of one result or stream chunk, in bytes. */
  maxResultBytes: 0,
  /** Wall-clock time for one call; for a stream method, until the stream ends. */
  timeoutMs: 0,
});

/** Names a bridge or alias global may not take. */
const RESERVED_GLOBALS = new Set([
  'host', 'sandboxImport', 'console', 'globalThis', 'self', 'window', 'document', 'fetch', 'postMessage',
  'undefined', 'NaN', 'Infinity', 'eval', 'arguments', 'Function', 'Object', 'Array', 'Promise',
  'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'WebTransport', 'EventSource', 'Worker', 'SharedWorker',
  'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'crypto', 'location', 'navigator',
]);

/** Names a method or namespace may not take (would break `await`, prototypes or the handle API). */
const RESERVED_MEMBERS = new Set(['then', 'constructor', 'prototype', '__proto__', 'destroy', 'toString', 'valueOf']);

/** `requiresUserActivation` kinds: transient (a gesture in the last few seconds) or sticky (any gesture since load). */
const ACTIVATION_KINDS = ['transient', 'sticky'];

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function makeDomError(message, name) {
  if (typeof DOMException === 'function') return new DOMException(message, name);
  const e = new Error(message);
  e.name = name;
  return e;
}

/** What crosses to the sandbox for an error: name, message, a few known fields. Never the stack. */
function serializeError(e) {
  const out = {
    name: e && typeof e.name === 'string' ? e.name : 'Error',
    message: e && e.message !== undefined ? String(e.message) : String(e),
  };
  if (e && typeof e.code === 'string') out.code = e.code;
  for (const k of ['requested', 'quota']) if (e && typeof e[k] === 'number') out[k] = e[k];
  return out;
}

function isPlainObject(v) {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;
}

function checkLimitValue(where, key, value) {
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new TypeError(`${where}.${key} must be a non-negative number (0 = unlimited); got ${String(value)}`);
  }
}

// ── Definitions ──

function normalizeMethod(where, spec) {
  if (typeof spec === 'function') {
    return { call: spec, stream: false, handle: false, requiresUserActivation: false };
  }
  if (spec === null || typeof spec !== 'object' || typeof spec.call !== 'function') {
    throw new TypeError(`${where} must be a function or { call, stream?, handle?, requiresUserActivation? }`);
  }
  for (const k of Object.keys(spec)) {
    if (!['call', 'stream', 'handle', 'requiresUserActivation'].includes(k)) {
      throw new TypeError(`${where}.${k} is not a known method option (expected call, stream, handle, requiresUserActivation)`);
    }
  }
  const ua = spec.requiresUserActivation ?? false;
  if (typeof ua !== 'boolean' && typeof ua !== 'function' && !ACTIVATION_KINDS.includes(ua)) {
    throw new TypeError(
      `${where}.requiresUserActivation must be true, 'transient', 'sticky', or a function (ctx, ...args) => boolean | 'transient' | 'sticky'`
    );
  }
  return { call: spec.call, stream: spec.stream === true, handle: spec.handle === true, requiresUserActivation: ua };
}

function checkMember(where, name) {
  if (!IDENTIFIER.test(name) || RESERVED_MEMBERS.has(name)) {
    throw new TypeError(`${where}: '${name}' is not allowed as a bridge member name`);
  }
}

/** Walk the `api` tree into a flat path -> method map. */
function flattenApi(where, tree, prefix, out) {
  if (tree === null || typeof tree !== 'object' || Array.isArray(tree)) {
    throw new TypeError(`${where} must be an object of methods and namespaces`);
  }
  for (const key of Object.keys(tree)) {
    checkMember(where, key);
    const value = tree[key];
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'function' || (value && typeof value === 'object' && typeof value.call === 'function')) {
      out.set(path, normalizeMethod(`${where}.${key}`, value));
    } else {
      flattenApi(`${where}.${key}`, value, path, out);
    }
  }
  return out;
}

/**
 * Validate one bridge definition. See `defineBridge()`.
 * @returns {object} the normalized definition
 */
function normalizeDefinition(name, def) {
  const where = `bridges.${name}`;
  if (def === null || typeof def !== 'object') throw new TypeError(`${where} must be a bridge definition object`);
  for (const k of Object.keys(def)) {
    if (!['api', 'handles', 'limits', 'onRequest', 'createState', 'stats', 'client', 'clientOptions', 'globals'].includes(k)) {
      throw new TypeError(`${where}.${k} is not a known bridge option`);
    }
  }
  const methods = flattenApi(`${where}.api`, def.api ?? {}, '', new Map());

  const handles = new Map();
  const handleDefs = def.handles ?? {};
  if (handleDefs === null || typeof handleDefs !== 'object') throw new TypeError(`${where}.handles must be an object`);
  for (const type of Object.keys(handleDefs)) {
    checkMember(`${where}.handles`, type);
    if (methods.has(type) || [...methods.keys()].some((p) => p.startsWith(`${type}.`))) {
      throw new TypeError(`${where}.handles.${type}: a handle type cannot share its name with an api member`);
    }
    const h = handleDefs[type];
    if (h === null || typeof h !== 'object') throw new TypeError(`${where}.handles.${type} must be an object`);
    const hm = new Map();
    for (const m of Object.keys(h.methods ?? {})) {
      checkMember(`${where}.handles.${type}.methods`, m);
      hm.set(m, normalizeMethod(`${where}.handles.${type}.methods.${m}`, h.methods[m]));
    }
    const props = h.props ?? [];
    if (!Array.isArray(props) || !props.every((p) => typeof p === 'string' && IDENTIFIER.test(p) && !RESERVED_MEMBERS.has(p) && !hm.has(p))) {
      throw new TypeError(`${where}.handles.${type}.props must be an array of property names (not method names)`);
    }
    if (h.destroy !== undefined && typeof h.destroy !== 'function') {
      throw new TypeError(`${where}.handles.${type}.destroy must be a function (target) => void`);
    }
    handles.set(type, { methods: hm, props: [...props], destroy: h.destroy ?? null });
  }

  const limits = { ...DEFAULT_BRIDGE_LIMITS };
  if (def.limits !== undefined) {
    if (def.limits === null || typeof def.limits !== 'object') throw new TypeError(`${where}.limits must be an object`);
    for (const k of Object.keys(def.limits)) {
      if (!hasOwn(DEFAULT_BRIDGE_LIMITS, k)) throw new TypeError(`${where}.limits.${k} is not a known limit`);
      checkLimitValue(`${where}.limits`, k, def.limits[k]);
      limits[k] = def.limits[k];
    }
  }
  for (const k of ['onRequest', 'createState', 'stats']) {
    if (def[k] !== undefined && typeof def[k] !== 'function') throw new TypeError(`${where}.${k} must be a function`);
  }
  let client = null;
  if (def.client !== undefined) {
    if (typeof def.client === 'function') client = def.client.toString();
    else if (typeof def.client === 'string') client = def.client;
    else throw new TypeError(`${where}.client must be a self-contained function (api, options) => api`);
  }
  const globals = {};
  for (const [alias, path] of Object.entries(def.globals ?? {})) {
    if (!IDENTIFIER.test(alias) || RESERVED_GLOBALS.has(alias)) throw new TypeError(`${where}.globals: '${alias}' is not allowed as a global name`);
    if (typeof path !== 'string' || !path.split('.').every((p) => IDENTIFIER.test(p))) {
      throw new TypeError(`${where}.globals.${alias} must be a dotted path into the bridge's api`);
    }
    globals[alias] = path;
  }
  if (def.clientOptions !== undefined) {
    try {
      JSON.stringify(def.clientOptions);
    } catch {
      throw new TypeError(`${where}.clientOptions must be JSON-serializable`);
    }
  }

  return {
    name,
    methods,
    handles,
    limits,
    onRequest: def.onRequest ?? null,
    createState: def.createState ?? null,
    stats: def.stats ?? null,
    client,
    clientOptions: def.clientOptions,
    globals,
  };
}

/**
 * Validate `createSandbox({ bridges })`. Throws a TypeError describing the
 * first problem; returns a Map of normalized definitions.
 */
export function normalizeBridges(bridges) {
  if (bridges === null || typeof bridges !== 'object' || Array.isArray(bridges)) {
    throw new TypeError('bridges must be an object: { name: bridgeDefinition }');
  }
  const out = new Map();
  const globalNames = new Set();
  for (const name of Object.keys(bridges)) {
    if (!IDENTIFIER.test(name) || RESERVED_GLOBALS.has(name)) {
      throw new TypeError(`bridges: '${name}' is not allowed as a bridge name (it becomes a global in the sandbox)`);
    }
    const def = normalizeDefinition(name, bridges[name]);
    for (const g of [name, ...Object.keys(def.globals)]) {
      if (globalNames.has(g)) throw new TypeError(`bridges: more than one bridge defines the global '${g}'`);
      globalNames.add(g);
    }
    out.set(name, def);
  }
  return out;
}

/**
 * Check a bridge definition and return it unchanged. Optional: `createSandbox`
 * validates `bridges` itself; this lets a bridge author fail early (and gives
 * TypeScript the definition type).
 */
export function defineBridge(definition) {
  normalizeDefinition('definition', definition);
  return definition;
}

/** What the sandbox needs to build the global: JSON only. */
function manifestOf(def) {
  const api = {};
  for (const [path, spec] of def.methods) api[path] = spec.stream ? 'stream' : 'call';
  const handles = {};
  for (const [type, h] of def.handles) {
    const methods = {};
    for (const [m, spec] of h.methods) methods[m] = spec.stream ? 'stream' : 'call';
    handles[type] = { methods, props: h.props };
  }
  return {
    api,
    handles,
    globals: def.globals,
    ...(def.client ? { client: def.client } : {}),
    ...(def.clientOptions !== undefined ? { clientOptions: def.clientOptions } : {}),
  };
}

/** Gate (capability) name of a bridge method: `ai.languageModel.create`, `ai.LanguageModel.prompt`. */
function gateName(bridge, method) {
  return `${bridge}.${method}`;
}

/** A rough byte count for `limits.maxResultBytes` (strings as UTF-8, binary by byteLength). */
export function estimateBytes(value, depth = 0) {
  if (value === null || value === undefined) return 0;
  switch (typeof value) {
    case 'string': return new TextEncoder().encode(value).byteLength;
    case 'number': case 'bigint': return 8;
    case 'boolean': return 4;
    case 'object': break;
    default: return 0;
  }
  if (depth > MAX_DEPTH) return 0;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size;
  let n = 0;
  if (value instanceof Map) {
    for (const [k, v] of value) n += estimateBytes(k, depth + 1) + estimateBytes(v, depth + 1);
    return n;
  }
  if (value instanceof Set) {
    for (const v of value) n += estimateBytes(v, depth + 1);
    return n;
  }
  if (Array.isArray(value)) {
    for (const v of value) n += estimateBytes(v, depth + 1);
    return n;
  }
  for (const k of Object.keys(value)) n += estimateBytes(k, depth + 1) + estimateBytes(value[k], depth + 1);
  return n;
}

/** Returned by `ctx.handle(type, target)`: the result encoder registers it. */
class HandleRef {
  constructor(type, target) {
    this.type = type;
    this.target = target;
  }
}

/** Snapshot of a handle's listed properties: primitives and arrays of primitives only. */
function readProps(rec) {
  const props = {};
  for (const p of rec.typeDef.props) {
    let v;
    try { v = rec.target[p]; } catch { continue; }
    if (v === null || ['string', 'number', 'boolean', 'undefined'].includes(typeof v)) props[p] = v;
    else if (Array.isArray(v) && v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) props[p] = [...v];
  }
  return props;
}

/** Make a ReadableStream / async iterable / iterable pullable. */
function toPuller(value) {
  if (value && typeof value.getReader === 'function') {
    const reader = value.getReader();
    return {
      next: () => reader.read(),
      close: (reason) => { try { return Promise.resolve(reader.cancel(reason)).catch(() => {}); } catch { return undefined; } },
    };
  }
  if (value && typeof value[Symbol.asyncIterator] === 'function') {
    const it = value[Symbol.asyncIterator]();
    return {
      next: () => it.next(),
      close: () => { try { return Promise.resolve(it.return?.()).catch(() => {}); } catch { return undefined; } },
    };
  }
  if (value && typeof value !== 'string' && typeof value[Symbol.iterator] === 'function') {
    const it = value[Symbol.iterator]();
    return {
      next: async () => it.next(),
      close: () => { try { it.return?.(); } catch {} },
    };
  }
  throw new TypeError('A stream method must return a ReadableStream or an (async) iterable');
}

/**
 * The per-sandbox bridge host.
 *
 * @param {Map<string, object>} defs  from normalizeBridges()
 */
export function createBridgeHost(defs) {
  const instances = new Map();
  const gateEntries = {};
  for (const [name, def] of defs) {
    const state = def.createState ? def.createState() : {};
    instances.set(name, { name, def, state, gated: new Map() });
    const names = [...def.methods.keys()];
    for (const [type, h] of def.handles) for (const m of h.methods.keys()) names.push(`${type}.${m}`);
    for (const method of names) {
      // The gate counts and limits the call; `this.run` is the actual work.
      gateEntries[gateName(name, method)] = function bridgeMethod() { return this.run(); };
    }
  }
  const gateNames = new Set(Object.keys(gateEntries));
  let gateLookup = null;
  let current = null; // the open session, for stats()

  const manifests = {};
  for (const [name, def] of defs) manifests[name] = manifestOf(def);

  /**
   * One session per Worker/frame.
   * @param {(message: object) => void} post  posts to that runtime; throws DataCloneError for uncloneable values
   */
  function openSession(post) {
    let closed = false;
    const calls = new Map(); // call id -> rec
    const streams = new Map(); // stream id -> rec
    const handles = new Map(); // handle id -> rec
    const pendingCallbacks = new Map(); // reverse-call id -> { resolve, reject }
    const releasedCallbacks = new Set();

    function send(message) {
      if (closed) return;
      post(message);
    }

    function forget(ids) {
      if (!ids.length) return;
      for (const id of ids) releasedCallbacks.add(id);
      try { send({ type: 'bridgeForget', callbacks: ids }); } catch {}
    }

    function makeCallbackProxy(inst, id) {
      const proxy = (...args) => new Promise((resolve, reject) => {
        if (closed) { reject(makeDomError('The sandbox is gone', 'InvalidStateError')); return; }
        if (releasedCallbacks.has(id)) { reject(makeDomError('The sandbox function was released', 'InvalidStateError')); return; }
        const rid = crypto.randomUUID();
        pendingCallbacks.set(rid, { resolve, reject });
        try {
          send({ type: 'bridgeCallback', id: rid, bridge: inst.name, callback: id, args });
        } catch (e) {
          pendingCallbacks.delete(rid);
          reject(new TypeError(`Arguments to a sandbox function must be structured-cloneable: ${e?.message ?? e}`));
        }
      });
      return proxy;
    }

    /** Markers from the sandbox -> host values. Copies plain objects/arrays. */
    function decodeArgs(inst, rec, value, depth) {
      if (value === null || typeof value !== 'object') return value;
      if (depth > MAX_DEPTH) throw new TypeError('Bridge call arguments are nested too deeply');
      if (hasOwn(value, MARK)) {
        const kind = value[MARK];
        if (kind === 'cb') {
          if (!validId(value.id)) throw new TypeError('Invalid function reference');
          if (!rec.callbacks.includes(value.id)) rec.callbacks.push(value.id);
          return makeCallbackProxy(inst, value.id);
        }
        if (kind === 'signal') return rec.controller.signal;
        if (kind === 'handle') {
          const h = validId(value.id) ? handles.get(value.id) : undefined;
          if (!h || h.inst !== inst) throw makeDomError('Unknown or destroyed object passed to a bridge call', 'InvalidStateError');
          return h.target;
        }
        throw new TypeError('Invalid bridge argument marker');
      }
      if (Array.isArray(value)) return value.map((v) => decodeArgs(inst, rec, v, depth + 1));
      if (isPlainObject(value)) {
        const out = {};
        for (const k of Object.keys(value)) {
          if (k === '__proto__') continue;
          out[k] = decodeArgs(inst, rec, value[k], depth + 1);
        }
        return out;
      }
      return value;
    }

    function destroyTarget(h) {
      if (!h.typeDef.destroy) return;
      try {
        const r = h.typeDef.destroy(h.target);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {
        // the host object is gone either way
      }
    }

    function registerHandle(inst, ref, owner) {
      const typeDef = inst.def.handles.get(ref.type);
      const fake = { typeDef, target: ref.target };
      if (closed) {
        destroyTarget(fake);
        throw makeDomError('The sandbox is gone', 'InvalidStateError');
      }
      const max = inst.def.limits.maxHandles;
      if (max > 0 && liveHandles(inst) >= max) {
        destroyTarget(fake);
        throw makeDomError(`Bridge '${inst.name}': handle limit reached (${max}); destroy() one first`, 'QuotaExceededError');
      }
      const id = crypto.randomUUID();
      const h = { id, inst, type: ref.type, typeDef, target: ref.target, callbacks: [], calls: new Set() };
      handles.set(id, h);
      owner?.created?.push(id);
      if (owner && owner.callbacks.length) {
        // Functions passed to the call that created this object live as long
        // as it does (e.g. Prompt API tools called by later prompts).
        h.callbacks.push(...owner.callbacks);
        owner.callbacks = [];
      }
      return { [MARK]: 'handle', id, type: ref.type, props: readProps(h) };
    }

    function liveHandles(inst) {
      let n = 0;
      for (const h of handles.values()) if (h.inst === inst) n++;
      return n;
    }

    function openStreams(inst) {
      let n = 0;
      for (const s of streams.values()) if (s.inst === inst) n++;
      return n;
    }

    /** Host values -> wire: HandleRefs become handle markers. */
    function encodeResult(inst, owner, value, depth) {
      if (value instanceof HandleRef) return registerHandle(inst, value, owner);
      if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
      if (Array.isArray(value)) return value.map((v) => encodeResult(inst, owner, v, depth + 1));
      if (isPlainObject(value)) {
        const out = {};
        for (const k of Object.keys(value)) out[k] = encodeResult(inst, owner, value[k], depth + 1);
        return out;
      }
      return value;
    }

    /** Destroy HandleRefs in a result nobody will receive. */
    function discardResult(inst, value, depth) {
      if (value instanceof HandleRef) {
        const typeDef = inst.def.handles.get(value.type);
        if (typeDef) destroyTarget({ typeDef, target: value.target });
        return;
      }
      if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return;
      if (Array.isArray(value)) for (const v of value) discardResult(inst, v, depth + 1);
      else if (isPlainObject(value)) for (const k of Object.keys(value)) discardResult(inst, value[k], depth + 1);
    }

    function checkSize(inst, value, what) {
      const max = inst.def.limits.maxResultBytes;
      if (max > 0) {
        const n = estimateBytes(value);
        if (n > max) throw makeDomError(`Bridge '${inst.name}': ${what} is ${n} bytes, over limits.maxResultBytes (${max})`, 'QuotaExceededError');
      }
    }

    function endCall(rec) {
      if (rec.timer) clearTimeout(rec.timer);
      rec.timer = null;
      calls.delete(rec.id);
      rec.handle?.calls.delete(rec);
      forget(rec.callbacks);
      rec.callbacks = [];
    }

    function replyError(id, error) {
      try { send({ type: 'bridgeResult', id, success: false, error: serializeError(error) }); } catch {}
    }

    function makeContext(inst, rec, method) {
      return {
        bridge: inst.name,
        method,
        signal: rec.controller.signal,
        state: inst.state,
        target: rec.handle ? rec.handle.target : undefined,
        handle(type, target) {
          if (!inst.def.handles.has(type)) throw new TypeError(`Bridge '${inst.name}' has no handle type '${type}'`);
          return new HandleRef(type, target);
        },
      };
    }

    async function onCall(msg) {
      const { id, bridge, handle: hid, method, args } = msg;
      if (!validId(id) || calls.has(id)) return;
      const inst = typeof bridge === 'string' ? instances.get(bridge) : undefined;
      if (!inst) { replyError(id, new TypeError(`Unknown bridge: ${String(bridge)}`)); return; }
      if (typeof method !== 'string') { replyError(id, new TypeError('Invalid bridge method')); return; }
      let spec;
      let handle = null;
      let methodName;
      if (hid !== null && hid !== undefined) {
        handle = validId(hid) ? handles.get(hid) : undefined;
        if (!handle || handle.inst !== inst) {
          replyError(id, makeDomError('The object has been destroyed', 'InvalidStateError'));
          return;
        }
        spec = handle.typeDef.methods.get(method);
        methodName = `${handle.type}.${method}`;
      } else {
        spec = inst.def.methods.get(method);
        methodName = method;
      }
      if (!spec) { replyError(id, new TypeError(`Unknown bridge method: ${bridge}.${method}`)); return; }
      if (!Array.isArray(args)) { replyError(id, new TypeError('Bridge call arguments must be an array')); return; }

      const rec = { id, inst, handle, controller: new AbortController(), callbacks: [], created: [], timer: null, stream: null };
      calls.set(id, rec);
      handle?.calls.add(rec);
      const { limits } = inst.def;
      if (limits.timeoutMs > 0) {
        rec.timer = setTimeout(() => {
          const err = makeDomError(`Bridge call ${bridge}.${methodName} timed out after ${limits.timeoutMs}ms`, 'TimeoutError');
          rec.controller.abort(err);
          if (rec.stream) closeStream(rec.stream, err, true);
        }, limits.timeoutMs);
      }

      let value;
      try {
        const decoded = decodeArgs(inst, rec, args, 0);
        if (spec.handle && limits.maxHandles > 0 && liveHandles(inst) >= limits.maxHandles) {
          throw makeDomError(`Bridge '${inst.name}': handle limit reached (${limits.maxHandles}); destroy() one first`, 'QuotaExceededError');
        }
        if (spec.stream && limits.maxStreams > 0 && openStreams(inst) >= limits.maxStreams) {
          throw makeDomError(`Bridge '${inst.name}': open stream limit reached (${limits.maxStreams})`, 'QuotaExceededError');
        }
        const gated = gateLookup?.(gateName(bridge, methodName));
        if (!gated) throw new TypeError(`Unknown bridge method: ${bridge}.${methodName}`);
        const ctx = makeContext(inst, rec, methodName);
        value = await gated.call({ run: () => runMethod(inst, rec, spec, ctx, methodName, decoded) }, ...args);
      } catch (e) {
        if (calls.get(id) === rec) {
          replyError(id, e);
          endCall(rec);
        }
        return;
      }
      if (calls.get(id) !== rec || closed || rec.controller.signal.aborted) {
        // Aborted, timed out, destroyed or the session closed while the host
        // was working: release what the method produced.
        if (spec.stream) { try { toPuller(value).close(); } catch {} }
        else discardResult(inst, value, 0);
        if (calls.get(id) === rec) {
          replyError(id, rec.controller.signal.reason ?? makeDomError('The operation was aborted', 'AbortError'));
          endCall(rec);
        }
        return;
      }

      if (spec.stream) {
        let puller;
        try {
          puller = toPuller(value);
        } catch (e) {
          replyError(id, e);
          endCall(rec);
          return;
        }
        const sid = crypto.randomUUID();
        const s = { id: sid, inst, rec, puller, reading: false, closed: false };
        rec.stream = s;
        streams.set(sid, s);
        try {
          send({ type: 'bridgeResult', id, success: true, value: { stream: sid } });
        } catch (e) {
          closeStream(s, e, false);
          replyError(id, e);
        }
        return;
      }

      try {
        const wire = encodeResult(inst, rec, value, 0);
        checkSize(inst, wire, 'the result');
        send({
          type: 'bridgeResult', id, success: true, value: wire,
          ...(handle && handles.has(handle.id) ? { props: readProps(handle) } : {}),
        });
      } catch (e) {
        // The sandbox never learns about handles this result registered.
        for (const hid of rec.created) {
          const h = handles.get(hid);
          if (h) destroyHandleRecord(h, e);
        }
        replyError(id, e.name === 'DataCloneError' || /clone/i.test(String(e?.message))
          ? makeDomError(`${bridge}.${methodName} returned a value that cannot be structured-cloned into the sandbox: ${e.message}`, 'DataCloneError')
          : e);
      }
      endCall(rec);
    }

    async function runMethod(inst, rec, spec, ctx, methodName, args) {
      let needed = spec.requiresUserActivation;
      if (typeof needed === 'function') needed = await needed(ctx, ...args);
      // true means transient; anything that is not a known kind means "not needed".
      const activation = needed === true ? 'transient' : ACTIVATION_KINDS.includes(needed) ? needed : null;
      const needsActivation = activation !== null;
      const ua = globalThis.navigator?.userActivation;
      const hasActivation = () => (activation === 'sticky' ? ua.hasBeenActive || ua.isActive : ua.isActive);
      const onRequest = inst.def.onRequest;
      if (onRequest) {
        let verdict;
        try {
          verdict = await onRequest({
            bridge: inst.name,
            method: methodName,
            args,
            handle: rec.handle ? { id: rec.handle.id, type: rec.handle.type } : null,
            requiresUserActivation: activation ?? false,
            userActivation: ua ? { isActive: ua.isActive, hasBeenActive: ua.hasBeenActive } : null,
            signal: rec.controller.signal,
          });
        } catch (e) {
          throw makeDomError(e?.message ? String(e.message) : `${inst.name}.${methodName} was denied by onRequest`, 'NotAllowedError');
        }
        if (verdict !== true) throw makeDomError(`${inst.name}.${methodName} was denied by onRequest`, 'NotAllowedError');
      }
      if (needsActivation && ua && !hasActivation()) {
        throw makeDomError(
          `${inst.name}.${methodName} requires ${activation} user activation (a click or key press on the page). ` +
          'Resolve onRequest from a click handler (for example a consent button) so the call runs while the page has activation.',
          'NotAllowedError'
        );
      }
      if (rec.controller.signal.aborted) throw rec.controller.signal.reason;
      return spec.call(ctx, ...args);
    }

    function closeStream(s, reason, notify) {
      if (s.closed) return;
      s.closed = true;
      streams.delete(s.id);
      if (!s.rec.controller.signal.aborted) {
        s.rec.controller.abort(reason ?? makeDomError('The stream was cancelled', 'AbortError'));
      }
      try { s.puller.close(reason); } catch {}
      if (notify) {
        try { send({ type: 'bridgeChunk', stream: s.id, error: serializeError(reason) }); } catch {}
      }
      endCall(s.rec);
    }

    async function onPull(msg) {
      const s = validId(msg.stream) ? streams.get(msg.stream) : undefined;
      if (!s || s.closed || s.reading) return;
      s.reading = true;
      let r;
      try {
        r = await s.puller.next();
      } catch (e) {
        if (!s.closed) closeStream(s, e, true);
        return;
      } finally {
        s.reading = false;
      }
      if (s.closed) return;
      const handle = s.rec.handle;
      if (r.done) {
        s.closed = true;
        streams.delete(s.id);
        try {
          send({ type: 'bridgeChunk', stream: s.id, done: true, ...(handle && handles.has(handle.id) ? { props: readProps(handle) } : {}) });
        } catch {}
        endCall(s.rec);
        return;
      }
      try {
        const wire = encodeResult(s.inst, s.rec, r.value, 0);
        checkSize(s.inst, wire, 'a stream chunk');
        send({ type: 'bridgeChunk', stream: s.id, value: wire });
      } catch (e) {
        closeStream(s, e.name === 'DataCloneError' || /clone/i.test(String(e?.message))
          ? makeDomError(`A stream chunk cannot be structured-cloned into the sandbox: ${e.message}`, 'DataCloneError')
          : e, true);
      }
    }

    function destroyHandleRecord(h, reason) {
      if (!handles.has(h.id)) return;
      handles.delete(h.id);
      for (const rec of [...h.calls]) {
        if (rec.stream) closeStream(rec.stream, reason, false);
        else if (!rec.controller.signal.aborted) rec.controller.abort(reason);
      }
      destroyTarget(h);
      forget(h.callbacks);
      h.callbacks = [];
    }

    function receive(msg) {
      if (closed || !msg || typeof msg.type !== 'string') return;
      switch (msg.type) {
        case 'bridgeCall':
          onCall(msg);
          break;
        case 'bridgeAbort': {
          const rec = validId(msg.id) ? calls.get(msg.id) : undefined;
          if (!rec) break;
          const reason = makeDomError('The operation was aborted by the sandbox', 'AbortError');
          if (rec.stream) closeStream(rec.stream, reason, false);
          else {
            rec.controller.abort(reason);
            endCall(rec);
          }
          break;
        }
        case 'bridgePull':
          onPull(msg);
          break;
        case 'bridgeCancel': {
          const s = validId(msg.stream) ? streams.get(msg.stream) : undefined;
          if (s) closeStream(s, makeDomError('The stream was cancelled by the sandbox', 'AbortError'), false);
          break;
        }
        case 'bridgeRelease': {
          const h = validId(msg.handle) ? handles.get(msg.handle) : undefined;
          if (h && h.inst.name === msg.bridge) destroyHandleRecord(h, makeDomError(`The ${h.type} has been destroyed`, 'AbortError'));
          break;
        }
        case 'bridgeCallbackResult': {
          const p = validId(msg.id) ? pendingCallbacks.get(msg.id) : undefined;
          if (!p) break;
          pendingCallbacks.delete(msg.id);
          if (msg.success) p.resolve(msg.value);
          else {
            const e = msg.error?.name === 'Error' || !msg.error?.name
              ? new Error(String(msg.error?.message ?? 'Sandbox function failed'))
              : makeDomError(String(msg.error?.message ?? 'Sandbox function failed'), String(msg.error.name));
            p.reject(e);
          }
          break;
        }
      }
    }

    /** The runtime is gone (dispose, timeout, abort, crash): release everything it held. */
    function close(reason = makeDomError('The sandbox was terminated', 'AbortError')) {
      if (closed) return;
      closed = true;
      for (const rec of [...calls.values()]) {
        if (rec.timer) clearTimeout(rec.timer);
        if (!rec.controller.signal.aborted) rec.controller.abort(reason);
      }
      for (const s of [...streams.values()]) {
        s.closed = true;
        try { s.puller.close(reason); } catch {}
      }
      for (const h of [...handles.values()]) destroyTarget(h);
      for (const p of pendingCallbacks.values()) p.reject(reason);
      calls.clear();
      streams.clear();
      handles.clear();
      pendingCallbacks.clear();
      if (current === session) current = null;
    }

    function sessionStats() {
      const out = {};
      for (const [name] of instances) out[name] = { handles: 0, streams: 0, calls: 0 };
      for (const h of handles.values()) out[h.inst.name].handles++;
      for (const s of streams.values()) out[s.inst.name].streams++;
      for (const c of calls.values()) out[c.inst.name].calls++;
      return out;
    }

    const session = { receive, close, stats: sessionStats, isClosed: () => closed };
    current = session;
    return session;
  }

  function stats() {
    const live = current ? current.stats() : null;
    const out = {};
    for (const [name, inst] of instances) {
      out[name] = {
        handles: live ? live[name].handles : 0,
        streams: live ? live[name].streams : 0,
        pendingCalls: live ? live[name].calls : 0,
        ...(inst.def.stats ? inst.def.stats(inst.state) : {}),
      };
    }
    return out;
  }

  return {
    manifests,
    gateEntries,
    /** Give the host the gate's lookup (gated functions are found by name). */
    useGate(lookup) { gateLookup = lookup; },
    /** True for the gate names of bridge methods, which `host.call()` must not reach. */
    isGateName: (name) => gateNames.has(name),
    openSession,
    stats,
  };
}
