/**
 * The in-sandbox half of `createSandbox({ bridges })` (andbox#46).
 *
 * `installBridges(post)` runs inside the sandbox runtime (Worker, worker
 * thread or iframe), before any evaluated code. It returns
 * `{ install(manifests), receive(message) }`: `install` builds one global per
 * bridge from a JSON manifest the host sends with `configure`, and `receive`
 * handles the host's `bridge*` replies.
 *
 * Stringified into the runtime with `toString()`, so it must not reference
 * anything outside its own body.
 *
 * Wire protocol (sandbox -> host):
 *   bridgeCall { id, bridge, handle, method, args }   one method call
 *   bridgeAbort { id }                                 the call's AbortSignal fired
 *   bridgePull { stream }                              send the next chunk
 *   bridgeCancel { stream }                            the stream was cancelled
 *   bridgeRelease { bridge, handle }                   handle.destroy()
 *   bridgeCallbackResult { id, success, value, error } reply to a reverse call
 * (host -> sandbox):
 *   bridgeResult { id, success, value, error, props }
 *   bridgeChunk { stream, done, value, error, props }
 *   bridgeCallback { id, callback, args }              call a sandbox function
 *   bridgeForget { callbacks }                         the host dropped these functions
 *
 * Values cross by structured clone. Functions, AbortSignals and handle objects
 * in arguments are replaced by markers `{ __andbox_bridge__: kind, id }`.
 *
 * @param {(message: object) => void} post
 */
export function installBridges(post) {
  const G = globalThis;
  const MARK = '__andbox_bridge__';
  // Captured before evaluated code runs, so changes to these globals later do
  // not change what the bridge does.
  const ReadableStreamCtor = G.ReadableStream;
  const AbortSignalCtor = G.AbortSignal;
  const DOMExceptionCtor = G.DOMException;
  const PromiseCtor = Promise;
  const MapCtor = Map;
  const WeakMapCtor = WeakMap;
  const ErrorCtor = Error;
  const NATIVE_ERRORS = { TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
  const randomUUID = G.crypto.randomUUID.bind(G.crypto);
  const defineProperty = Object.defineProperty;
  const getPrototypeOf = Object.getPrototypeOf;
  const keys = Object.keys;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isArray = Array.isArray;
  const ObjectProto = Object.prototype;
  const asyncIteratorSymbol = Symbol.asyncIterator;
  const disposeSymbol = Symbol.dispose;
  const toStringTagSymbol = Symbol.toStringTag;
  const MAX_DEPTH = 64;

  let manifests = Object.create(null);
  const calls = new MapCtor(); // call id -> record
  const streams = new MapCtor(); // stream id -> record
  const callbacks = new MapCtor(); // callback id -> function
  const handleState = new WeakMapCtor(); // handle object -> state
  const liveHandles = new MapCtor(); // bridge + '\0' + id -> state

  function domError(message, name) {
    if (typeof DOMExceptionCtor === 'function') return new DOMExceptionCtor(message, name);
    const e = new ErrorCtor(message);
    e.name = name;
    return e;
  }

  function abortReason(signal) {
    return signal.reason !== undefined ? signal.reason : domError('This operation was aborted', 'AbortError');
  }

  /** Rebuild an error the host sent as `{ name, message, ... }`. */
  function toError(data) {
    const name = data && typeof data.name === 'string' ? data.name : 'Error';
    const message = data && typeof data.message === 'string' ? data.message : 'Bridge call failed';
    let e;
    if (hasOwn(NATIVE_ERRORS, name)) e = new NATIVE_ERRORS[name](message);
    else if (name !== 'Error' && typeof DOMExceptionCtor === 'function') e = new DOMExceptionCtor(message, name);
    else { e = new ErrorCtor(message); if (name !== 'Error') e.name = name; }
    if (data && typeof data.code === 'string') { try { e.code = data.code; } catch {} }
    for (const k of ['requested', 'quota']) {
      if (data && typeof data[k] === 'number') { try { defineProperty(e, k, { value: data[k], enumerable: true, configurable: true }); } catch {} }
    }
    return e;
  }

  function isPlainObject(v) {
    const proto = getPrototypeOf(v);
    return proto === ObjectProto || proto === null;
  }

  /**
   * Replace functions, AbortSignals and handle objects in `value` by markers.
   * `acc` collects the signals and callback ids of one call.
   */
  function encode(value, acc, depth, seen) {
    if (typeof value === 'function') {
      let id = acc.fnIds.get(value);
      if (id === undefined) {
        id = randomUUID();
        acc.fnIds.set(value, id);
        callbacks.set(id, value);
        acc.callbacks.push(id);
      }
      return { [MARK]: 'cb', id };
    }
    if (value === null || typeof value !== 'object') return value;
    const hs = handleState.get(value);
    if (hs) {
      if (hs.destroyed) throw domError('A destroyed object was passed to a bridge call', 'InvalidStateError');
      return { [MARK]: 'handle', id: hs.id };
    }
    if (typeof AbortSignalCtor === 'function' && value instanceof AbortSignalCtor) {
      if (!acc.signals.includes(value)) acc.signals.push(value);
      return { [MARK]: 'signal' };
    }
    if (depth > MAX_DEPTH) throw new TypeError('Bridge call arguments are nested too deeply');
    if (isArray(value) || isPlainObject(value)) {
      if (seen.includes(value)) throw new TypeError('Bridge call arguments cannot contain cycles');
      seen.push(value);
      let out;
      if (isArray(value)) {
        out = [];
        for (let i = 0; i < value.length; i++) out.push(encode(value[i], acc, depth + 1, seen));
      } else {
        out = {};
        for (const k of keys(value)) {
          if (k === '__proto__') continue;
          out[k] = encode(value[k], acc, depth + 1, seen);
        }
      }
      seen.pop();
      return out;
    }
    // Dates, Maps, typed arrays, Blobs, ImageBitmaps...: structured clone.
    return value;
  }

  /** Turn handle markers from the host into handle objects. */
  function decode(bridge, value, depth) {
    if (value === null || typeof value !== 'object' || depth > MAX_DEPTH) return value;
    if (hasOwn(value, MARK)) {
      if (value[MARK] === 'handle') return makeHandle(bridge, value);
      return value;
    }
    if (isArray(value)) {
      for (let i = 0; i < value.length; i++) value[i] = decode(bridge, value[i], depth + 1);
    } else if (isPlainObject(value)) {
      for (const k of keys(value)) value[k] = decode(bridge, value[k], depth + 1);
    }
    return value;
  }

  function forgetCallbacks(ids) {
    for (const id of ids) callbacks.delete(id);
  }

  /**
   * Start one call. Returns the call record; `record.promise` settles with the
   * host's reply (a value, or `{ stream }` for stream methods).
   */
  function startCall(bridge, hs, method, args, isStream) {
    const record = { id: randomUUID(), bridge, hs, isStream, settled: false, signals: [], onAbort: null, stream: null };
    record.promise = new PromiseCtor((resolve, reject) => {
      record.resolve = resolve;
      record.reject = reject;
    });
    const early = (error) => {
      record.settled = true;
      record.reject(error);
      return record;
    };
    if (hs && hs.destroyed) return early(domError(`The ${hs.type} has been destroyed`, 'InvalidStateError'));
    const acc = { signals: record.signals, callbacks: [], fnIds: new MapCtor() };
    let wire;
    try {
      wire = encode(args, acc, 0, []);
    } catch (e) {
      forgetCallbacks(acc.callbacks);
      return early(e);
    }
    for (const s of record.signals) {
      if (s.aborted) {
        forgetCallbacks(acc.callbacks);
        return early(abortReason(s));
      }
    }
    record.onAbort = (event) => {
      const signal = event && event.target ? event.target : record.signals.find((s) => s.aborted);
      const reason = signal ? abortReason(signal) : domError('This operation was aborted', 'AbortError');
      try { post({ type: 'bridgeAbort', id: record.id }); } catch {}
      fail(record, reason);
    };
    for (const s of record.signals) s.addEventListener('abort', record.onAbort, { once: true });
    calls.set(record.id, record);
    try {
      post({ type: 'bridgeCall', id: record.id, bridge, handle: hs ? hs.id : null, method, args: wire });
    } catch (e) {
      forgetCallbacks(acc.callbacks);
      fail(record, e);
    }
    return record;
  }

  /** Done with a call: drop it and its abort listeners. */
  function finish(record) {
    if (record.settled) return false;
    record.settled = true;
    calls.delete(record.id);
    for (const s of record.signals) s.removeEventListener('abort', record.onAbort);
    return true;
  }

  function fail(record, error) {
    const st = record.stream;
    if (!finish(record)) return;
    if (st) failStream(st, error);
    record.reject(error);
  }

  function invoke(bridge, hs, method, args) {
    const record = startCall(bridge, hs, method, args, false);
    return record.promise;
  }

  function failStream(st, error) {
    if (st.closed) return;
    st.closed = true;
    streams.delete(st.id);
    try { st.controller.error(error); } catch {}
    if (st.waiter) { st.waiter.resolve(); st.waiter = null; }
  }

  function addAsyncIterator(stream) {
    if (asyncIteratorSymbol in stream) return stream;
    const values = function ({ preventCancel = false } = {}) {
      const reader = stream.getReader();
      return {
        next() { return reader.read(); },
        async return(value) {
          if (!preventCancel) await reader.cancel(value);
          reader.releaseLock();
          return { done: true, value };
        },
        [asyncIteratorSymbol]() { return this; },
      };
    };
    defineProperty(stream, 'values', { value: values, configurable: true, writable: true });
    defineProperty(stream, asyncIteratorSymbol, { value: values, configurable: true, writable: true });
    return stream;
  }

  /** A stream method: returns a ReadableStream at once, like the platform's. */
  function invokeStream(bridge, hs, method, args) {
    let record;
    const st = { id: null, controller: null, waiter: null, closed: false, hs, record: null };
    const stream = new ReadableStreamCtor({
      start(controller) {
        st.controller = controller;
        record = startCall(bridge, hs, method, args, true);
        st.record = record;
        if (!record.settled) record.stream = st;
        return record.promise.then((reply) => {
          if (st.closed) return;
          st.id = reply && typeof reply.stream === 'string' ? reply.stream : null;
          if (!st.id) throw new TypeError('Bridge stream method returned no stream');
          streams.set(st.id, st);
        });
      },
      pull() {
        if (st.closed || !st.id) return undefined;
        return new PromiseCtor((resolve, reject) => {
          st.waiter = { resolve, reject };
          try { post({ type: 'bridgePull', stream: st.id }); } catch (e) { st.waiter = null; reject(e); }
        });
      },
      cancel() {
        if (st.closed) return;
        st.closed = true;
        if (st.id) {
          streams.delete(st.id);
          try { post({ type: 'bridgeCancel', stream: st.id }); } catch {}
        } else if (record && !record.settled) {
          try { post({ type: 'bridgeAbort', id: record.id }); } catch {}
        }
        if (record) finish(record);
      },
    });
    return addAsyncIterator(stream);
  }

  function destroyHandle(hs, notifyHost) {
    if (hs.destroyed) return;
    hs.destroyed = true;
    liveHandles.delete(hs.bridge + '\0' + hs.id);
    if (notifyHost) {
      try { post({ type: 'bridgeRelease', bridge: hs.bridge, handle: hs.id }); } catch {}
    }
    // Like the platform: pending calls on a destroyed object reject.
    const reason = domError(`The ${hs.type} has been destroyed`, 'AbortError');
    for (const record of [...calls.values()]) {
      if (record.hs === hs) fail(record, reason);
    }
    for (const st of [...streams.values()]) {
      if (st.hs === hs) {
        failStream(st, reason);
        if (st.record) finish(st.record);
      }
    }
  }

  function makeHandle(bridge, desc) {
    const manifest = manifests[bridge];
    const type = manifest && typeof desc.type === 'string' && hasOwn(manifest.handles, desc.type) ? manifest.handles[desc.type] : null;
    if (!type || typeof desc.id !== 'string') return desc;
    const key = bridge + '\0' + desc.id;
    const existing = liveHandles.get(key);
    if (existing) {
      if (desc.props) existing.props = desc.props;
      return existing.object;
    }
    const hs = { bridge, id: desc.id, type: desc.type, destroyed: false, props: desc.props || {}, object: null };
    const obj = {};
    for (const name of keys(type.methods)) {
      const fn = type.methods[name] === 'stream'
        ? function (...args) { return invokeStream(bridge, hs, name, args); }
        : function (...args) { return invoke(bridge, hs, name, args); };
      defineProperty(fn, 'name', { value: name });
      defineProperty(obj, name, { value: fn, writable: true, configurable: true });
    }
    for (const prop of type.props) {
      defineProperty(obj, prop, { get() { return hs.props[prop]; }, enumerable: true, configurable: true });
    }
    const destroy = function destroy() { destroyHandle(hs, true); };
    defineProperty(obj, 'destroy', { value: destroy, writable: true, configurable: true });
    if (disposeSymbol) defineProperty(obj, disposeSymbol, { value: destroy, writable: true, configurable: true });
    defineProperty(obj, toStringTagSymbol, { value: desc.type, configurable: true });
    hs.object = obj;
    handleState.set(obj, hs);
    liveHandles.set(key, hs);
    return obj;
  }

  function buildApi(bridge, manifest) {
    const root = {};
    for (const path of keys(manifest.api)) {
      const parts = path.split('.');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!hasOwn(node, parts[i])) node[parts[i]] = {};
        node = node[parts[i]];
      }
      const name = parts[parts.length - 1];
      const fn = manifest.api[path] === 'stream'
        ? function (...args) { return invokeStream(bridge, null, path, args); }
        : function (...args) { return invoke(bridge, null, path, args); };
      defineProperty(fn, 'name', { value: name });
      node[name] = fn;
    }
    return root;
  }

  function lookupPath(root, path) {
    let node = root;
    for (const part of path.split('.')) {
      if (node === null || typeof node !== 'object' || !hasOwn(node, part)) return undefined;
      node = node[part];
    }
    return node;
  }

  function defineGlobal(name, value) {
    try { delete G[name]; } catch {}
    defineProperty(G, name, { value, writable: true, configurable: true, enumerable: false });
  }

  function install(list) {
    manifests = Object.create(null);
    for (const name of keys(list)) manifests[name] = list[name];
    for (const name of keys(list)) {
      const manifest = list[name];
      let api = buildApi(name, manifest);
      if (typeof manifest.client === 'string') {
        // Host-authored adapter for platform-specific shapes (e.g. Chrome AI's
        // `monitor`); it runs here, with no more authority than the sandbox.
        const client = new Function(`return (${manifest.client});`)();
        const adapted = client(api, manifest.clientOptions === undefined ? {} : manifest.clientOptions);
        if (adapted !== undefined) api = adapted;
      }
      defineGlobal(name, api);
      for (const alias of keys(manifest.globals || {})) {
        const target = lookupPath(api, manifest.globals[alias]);
        if (target !== undefined) defineGlobal(alias, target);
      }
    }
  }

  async function runCallback(msg) {
    const fn = callbacks.get(msg.callback);
    if (!fn) {
      post({ type: 'bridgeCallbackResult', id: msg.id, success: false, error: { name: 'InvalidStateError', message: 'The sandbox function was released' } });
      return;
    }
    let reply;
    try {
      const args = isArray(msg.args) ? msg.args.map((a) => decode(msg.bridge, a, 0)) : [];
      const value = await fn(...args);
      reply = { type: 'bridgeCallbackResult', id: msg.id, success: true, value };
    } catch (e) {
      reply = {
        type: 'bridgeCallbackResult', id: msg.id, success: false,
        error: { name: e && typeof e.name === 'string' ? e.name : 'Error', message: e && e.message ? String(e.message) : String(e) },
      };
    }
    try {
      post(reply);
    } catch (e) {
      post({ type: 'bridgeCallbackResult', id: msg.id, success: false, error: { name: 'DataCloneError', message: `The sandbox function's result cannot be sent to the host: ${e && e.message ? e.message : e}` } });
    }
  }

  function receive(msg) {
    switch (msg.type) {
      case 'bridgeResult': {
        const record = calls.get(msg.id);
        if (!record) return true;
        if (record.hs && msg.props && !record.hs.destroyed) record.hs.props = msg.props;
        if (msg.success) {
          let value;
          try { value = record.isStream ? msg.value : decode(record.bridge, msg.value, 0); } catch (e) { fail(record, e); return true; }
          if (record.isStream) {
            // Keep the record (and its abort listeners) until the stream ends.
            record.resolve(value);
          } else if (finish(record)) {
            record.resolve(value);
          }
        } else {
          fail(record, toError(msg.error));
        }
        return true;
      }
      case 'bridgeChunk': {
        const st = streams.get(msg.stream);
        if (!st || st.closed) return true;
        const waiter = st.waiter;
        st.waiter = null;
        if (st.hs && msg.props && !st.hs.destroyed) st.hs.props = msg.props;
        if (msg.error) {
          failStream(st, toError(msg.error));
          if (st.record) finish(st.record);
        } else if (msg.done) {
          st.closed = true;
          streams.delete(st.id);
          try { st.controller.close(); } catch {}
          if (st.record) finish(st.record);
        } else {
          try { st.controller.enqueue(decode(st.record ? st.record.bridge : '', msg.value, 0)); } catch {}
        }
        if (waiter) waiter.resolve();
        return true;
      }
      case 'bridgeCallback':
        runCallback(msg);
        return true;
      case 'bridgeForget':
        if (isArray(msg.callbacks)) forgetCallbacks(msg.callbacks);
        return true;
      default:
        return false;
    }
  }

  return { install, receive };
}
