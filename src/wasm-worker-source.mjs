/**
 * Worker source for `mode: 'wasm'` (andbox#21).
 *
 * The worker script is the function below, stringified. The user's code never
 * runs in this Worker's JavaScript realm: it runs inside QuickJS-ng compiled
 * to WebAssembly (one runtime + context per `evaluate()`), whose only way out
 * is the single native function behind `host.call`. The Worker's own globals
 * (`fetch`, `WebSocket`, `importScripts`, `indexedDB`, `postMessage`, ...) are
 * simply not present in that engine.
 *
 * Protocol (same message types as the plain worker script, plus a few
 * fields): the host sends `configure` (with `wasm: { engineURL, wasmURL }`),
 * `defineModule`, `evaluate` (with `limits`), `capabilityResult`, `dispose`;
 * the Worker sends `configured` (with `error` if the engine failed to load),
 * `moduleDefined`, `result` (with `stats` and, for failures, `error.code`),
 * `capabilityCall`, `console`.
 *
 * The function must stay self-contained (no free variables): it is inlined as
 * text via `Function.prototype.toString`, exactly like `installNodeVfs`.
 */

/** Error codes carried on `result.error.code` and on the rejected Error. */
export const WASM_ERROR_CODES = Object.freeze({
  FuelExhaustedError: 'ERR_ANDBOX_FUEL_EXHAUSTED',
  MemoryLimitError: 'ERR_ANDBOX_MEMORY_LIMIT',
  TimeoutError: 'ERR_ANDBOX_DEADLINE',
  EngineError: 'ERR_ANDBOX_ENGINE',
});

function wasmWorkerMain() {
  'use strict';

  const CODES = {
    FuelExhaustedError: 'ERR_ANDBOX_FUEL_EXHAUSTED',
    MemoryLimitError: 'ERR_ANDBOX_MEMORY_LIMIT',
    TimeoutError: 'ERR_ANDBOX_DEADLINE',
    EngineError: 'ERR_ANDBOX_ENGINE',
  };
  const RESOLVE_FAILED = 'andbox:resolve-failed:';
  const PAGE = 65536;
  const INITIAL_PAGES = 256; // 16 MiB, what the engine build asks for
  const MAX_PAGES = 32768; // 2 GiB, the wasm32 / engine-build ceiling
  const HARD_CAP_BASE_BYTES = 32 * 1024 * 1024;

  let importMap = { imports: {}, scopes: {} };
  const virtualModules = new Map();
  let config = null; // { engineURL, wasmURL }
  let enginePromise = null;
  const pendingRpc = new Map();
  const live = new Set(); // abort functions for in-flight evaluations
  let rpcSeq = 0;

  // ── Engine ──

  async function loadEngine() {
    const eng = await import(config.engineURL);
    // Hard cap on the engine's linear memory. QuickJS's own memory limit only
    // counts allocation *blocks* in this build (no malloc_usable_size), so it
    // cannot bound total bytes; the wasm memory maximum can, and a failed
    // grow surfaces in the guest as an out-of-memory error.
    const maxPages = config.memoryBytes > 0
      ? Math.min(MAX_PAGES, Math.max(INITIAL_PAGES, Math.ceil((2 * config.memoryBytes + HARD_CAP_BASE_BYTES) / PAGE)))
      : MAX_PAGES;
    const variant = eng.newVariant(eng.variant, {
      ...(config.wasmURL ? { wasmLocation: config.wasmURL } : {}),
      wasmMemory: new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: maxPages }),
    });
    return eng.newQuickJSWASMModuleFromVariant(variant);
  }

  function getEngine() {
    if (!enginePromise) {
      enginePromise = loadEngine().catch((e) => {
        enginePromise = null;
        throw e;
      });
    }
    return enginePromise;
  }

  // ── Guest bootstrap (runs inside QuickJS, not in this Worker) ──
  // Receives the two native bridge functions as arguments, so they are never
  // reachable as globals. Everything else is plain JS.
  function guestBoot(nativeCall, nativeLog) {
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    const str = String;
    const fmt = (a) => {
      try {
        if (typeof a !== 'object') return str(a);
        const s = stringify(a);
        return s === undefined ? str(a) : s;
      } catch {
        return str(a);
      }
    };
    const log = (level) => (...args) => {
      nativeLog(level, stringify(args.map(fmt)));
    };
    const consoleObj = {
      log: log('log'), warn: log('warn'), error: log('error'),
      info: log('info'), debug: log('debug'),
    };
    globalThis.console = consoleObj;
    const host = Object.freeze({
      call: async (name, ...args) => {
        const r = await nativeCall(str(name), stringify(args));
        return r === '' ? undefined : parse(r);
      },
    });
    const sandboxImport = (specifier) => import(str(specifier));
    const ser = (v) => {
      if (v === undefined) return '{"t":"u"}';
      if (typeof v === 'function') return '{"t":"v","v":"[Function]"}';
      try {
        const s = stringify(v);
        if (s !== undefined) return '{"t":"v","v":' + s + '}';
      } catch {}
      try { return stringify({ t: 'v', v: str(v) }); } catch { return '{"t":"v","v":"[object]"}'; }
    };
    return { host, sandboxImport, ser, console: consoleObj };
  }

  // ── Virtual modules for the in-guest module loader ──

  function lookupModule(name) {
    const bare = name.replace(/\.m?js$/, '');
    for (const cand of [name, name + '.js', name + '.mjs', name + '/index.js', bare]) {
      if (virtualModules.has(cand)) return cand;
    }
    return null;
  }

  function mapSpecifier(specifier) {
    const m = importMap.imports || {};
    if (m[specifier] !== undefined) return m[specifier];
    let best = null;
    for (const key of Object.keys(m)) {
      if (key.endsWith('/') && specifier.startsWith(key) && (best === null || key.length > best.length)) best = key;
    }
    return best === null ? null : m[best] + specifier.slice(best.length);
  }

  function normalizeModule(base, requested) {
    let name = null;
    if (requested.startsWith('./') || requested.startsWith('../')) {
      const parts = (lookupModule(base) ?? base).split('/');
      parts.pop();
      for (const seg of requested.split('/')) {
        if (seg === '..') parts.pop();
        else if (seg !== '.' && seg !== '') parts.push(seg);
      }
      name = lookupModule(parts.join('/'));
    } else {
      name = lookupModule(requested);
      if (name === null) {
        const mapped = mapSpecifier(requested);
        if (mapped !== null) name = lookupModule(mapped);
      }
    }
    if (name === null) {
      throw new Error(
        'Cannot resolve module: ' + requested +
        ". In mode: 'wasm' only virtual modules (defineModule) can be imported; URLs are never fetched."
      );
    }
    return name;
  }

  // ── Evaluation ──

  function errorFrom(name, message) {
    return { name, message, code: CODES[name] };
  }

  async function runEval(msg) {
    const limits = msg.limits || {};
    let QJS;
    try {
      QJS = await getEngine();
    } catch (e) {
      return { success: false, error: errorFrom('EngineError', 'Failed to load the WASM engine: ' + (e?.message ?? e)) };
    }

    return new Promise((resolveEval) => {
      const t0 = Date.now();
      const deadlineAt = limits.deadlineMs > 0 ? t0 + limits.deadlineMs : 0;
      let polls = 0;
      let peak = 0;
      let fuelHit = false;
      let deadlineHit = false;
      let done = false;
      let timer = null;
      let rt = null;
      let ctx = null;
      const owned = []; // handles to dispose, in creation order
      const own = (h) => { owned.push(h); return h; };
      const rpcIds = new Set();
      const deferreds = new Set();

      let memHit = false;
      let nextSampleAt = 0;
      // JS heap bytes in use right now, or -1 if the usage report itself could
      // not be allocated (the heap is at its limit).
      function sample() {
        if (!rt || !ctx || !ctx.alive) return 0;
        try {
          const h = rt.computeMemoryUsage();
          try {
            const used = ctx.getProp(h, 'memory_used_size').consume((x) => ctx.getNumber(x));
            if (used > peak) peak = used;
            return used;
          } finally {
            h.dispose();
          }
        } catch {
          return -1;
        }
      }

      function teardown() {
        for (const id of rpcIds) pendingRpc.delete(id);
        rpcIds.clear();
        for (const d of deferreds) { try { if (d.alive) d.dispose(); } catch {} }
        deferreds.clear();
        for (let i = owned.length - 1; i >= 0; i--) { try { if (owned[i].alive) owned[i].dispose(); } catch {} }
        owned.length = 0;
        try { if (ctx?.alive) ctx.dispose(); } catch { enginePromise = null; }
        try { if (rt?.alive) rt.dispose(); } catch { enginePromise = null; }
        ctx = null;
        rt = null;
      }

      function finish(result) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        live.delete(abort);
        try { sample(); } catch {}
        result.stats = { fuelUsed: polls, peakMemoryBytes: peak };
        teardown();
        resolveEval(result);
      }

      function abort(message) {
        finish({ success: false, error: { name: 'Error', message } });
      }
      live.add(abort);

      function failure(errHandle) {
        try {
          return mapFailure(errHandle);
        } finally {
          try { if (errHandle?.alive) errHandle.dispose(); } catch {}
        }
      }

      function mapFailure(errHandle) {
        // Map whatever the guest threw (or the engine reported) to a result.
        if (fuelHit) return { success: false, error: errorFrom('FuelExhaustedError', 'Fuel exhausted after ' + polls + ' interrupt polls (limit ' + limits.fuel + ')') };
        if (memHit) return { success: false, error: errorFrom('MemoryLimitError', 'Memory limit exceeded (' + limits.memoryBytes + ' bytes of JS heap)') };
        if (deadlineHit) return { success: false, error: errorFrom('TimeoutError', 'Sandbox execution timed out after ' + limits.deadlineMs + 'ms') };
        let dumped;
        try { dumped = ctx.dump(errHandle); } catch { dumped = null; }
        let name = 'Error';
        let message = '';
        let stack;
        if (dumped && typeof dumped === 'object') {
          name = dumped.name || 'Error';
          message = dumped.message !== undefined ? String(dumped.message) : JSON.stringify(dumped);
          stack = dumped.stack;
        } else {
          message = String(dumped);
        }
        if (name === 'InternalError' && /out of memory/i.test(message)) {
          return { success: false, error: errorFrom('MemoryLimitError', 'Memory limit exceeded (' + limits.memoryBytes + ' bytes)') };
        }
        return { success: false, error: { name, message, stack } };
      }

      try {
        rt = QJS.newRuntime();
        if (limits.memoryBytes > 0) rt.setMemoryLimit(limits.memoryBytes);
        if (limits.stackBytes > 0) rt.setMaxStackSize(limits.stackBytes);
        rt.setInterruptHandler(() => {
          polls++;
          if (fuelHit || deadlineHit || memHit) return true;
          if (limits.fuel > 0 && polls > limits.fuel) { fuelHit = true; return true; }
          if (deadlineAt && Date.now() > deadlineAt) { deadlineHit = true; return true; }
          // Walking the heap costs ~1-2 ms per MB of live objects, so sample on a
          // time budget (about 10% of run time) rather than every poll.
          const now = performance.now();
          if (now >= nextSampleAt) {
            const used = sample();
            nextSampleAt = performance.now() + Math.max(1, (performance.now() - now) * 9);
            if (used < 0 || (limits.memoryBytes > 0 && used > limits.memoryBytes)) { memHit = true; return true; }
          }
          return false;
        });
        rt.setModuleLoader(
          (name) => {
            if (virtualModules.has(name)) return virtualModules.get(name);
            // QuickJS ignores a failing normalizer and calls the loader with
            // an empty name, so a failed resolution travels as a marker name.
            if (name.startsWith(RESOLVE_FAILED)) return { error: new Error(name.slice(RESOLVE_FAILED.length)) };
            return { error: new Error('Cannot load module: ' + name) };
          },
          (base, requested) => {
            try {
              return normalizeModule(base, requested);
            } catch (e) {
              return RESOLVE_FAILED + (e?.message ?? e);
            }
          }
        );
        ctx = rt.newContext();

        const nativeLog = own(ctx.newFunction('log', (levelH, argsH) => {
          if (done) return;
          let args;
          try { args = JSON.parse(ctx.getString(argsH)); } catch { args = []; }
          self.postMessage({ type: 'console', evalId: msg.id, consoleId: msg.consoleId, level: ctx.getString(levelH), args });
        }));

        const nativeCall = own(ctx.newFunction('call', (nameH, argsH) => {
          const name = ctx.getString(nameH);
          const args = JSON.parse(ctx.getString(argsH));
          const deferred = ctx.newPromise();
          deferreds.add(deferred);
          const id = 'w' + (++rpcSeq);
          rpcIds.add(id);
          pendingRpc.set(id, {
            resolve(value) {
              if (done || !deferred.alive) return;
              let text = '';
              try { text = value === undefined ? '' : JSON.stringify(value) ?? ''; } catch (e) {
                deferred.reject(ctx.newError('Capability result is not JSON-serializable'));
                pump();
                return;
              }
              const v = ctx.newString(text);
              deferred.resolve(v);
              v.dispose();
              pump();
            },
            reject(error) {
              if (done || !deferred.alive) return;
              const e = ctx.newError(String(error?.message ?? error));
              deferred.reject(e);
              e.dispose();
              pump();
            },
          });
          self.postMessage({ type: 'capabilityCall', id, name, args });
          return deferred.handle;
        }));

        const boot = ctx.evalCode('(' + guestBoot.toString() + ')', 'andbox-boot.js');
        if (boot.error) { finish(failure(boot.error)); return; }
        own(boot.value);
        const bridge = ctx.callFunction(boot.value, ctx.undefined, nativeCall, nativeLog);
        if (bridge.error) { finish(failure(bridge.error)); return; }
        own(bridge.value);
        const hostH = own(ctx.getProp(bridge.value, 'host'));
        const importH = own(ctx.getProp(bridge.value, 'sandboxImport'));
        const consoleH = own(ctx.getProp(bridge.value, 'console'));
        const serH = own(ctx.getProp(bridge.value, 'ser'));

        // Same wrapper as worker mode, including the newline that keeps a
        // trailing // comment from swallowing the closing brace (andbox#23).
        const fn = ctx.evalCode(
          '(async (sandboxImport, host, console) => {\n' + msg.code + '\n})',
          'eval.js'
        );
        if (fn.error) { finish(failure(fn.error)); return; }
        own(fn.value);

        // Cooperative wall-clock deadline for time spent awaiting host calls
        // (the interrupt handler covers time spent executing guest code).
        if (deadlineAt) {
          timer = setTimeout(() => {
            deadlineHit = true;
            finish(failure(null));
          }, Math.max(0, deadlineAt - Date.now()));
        }

        const call = ctx.callFunction(fn.value, ctx.undefined, importH, hostH, consoleH);
        if (call.error) { finish(failure(call.error)); return; }
        const promiseH = own(call.value);

        function pump() {
          if (done) return;
          try {
            let guard = 0;
            while (!fuelHit && !deadlineHit && !memHit && rt.hasPendingJob() && guard++ < 1e6) {
              const jr = rt.executePendingJobs();
              if (jr.error) jr.error.dispose();
            }
            if (fuelHit || deadlineHit || memHit) { finish(failure(null)); return; }
            const st = ctx.getPromiseState(promiseH);
            if (st.type === 'pending') return;
            if (st.type === 'rejected') {
              finish(failure(st.error));
              return;
            }
            const sr = ctx.callFunction(serH, ctx.undefined, st.value);
            if (st.value?.alive) st.value.dispose();
            if (sr.error) { finish(failure(sr.error)); return; }
            const parsed = JSON.parse(ctx.getString(sr.value));
            sr.value.dispose();
            finish({ success: true, value: parsed.t === 'u' ? undefined : parsed.v });
          } catch (e) {
            // An exception escaping the engine (e.g. host stack overflow, wasm
            // abort) leaves it in an unknown state: drop it and reload.
            enginePromise = null;
            done || (done = true, clearTimeout(timer), live.delete(abort), resolveEval({
              success: false,
              error: errorFrom('EngineError', 'WASM engine fault: ' + (e?.message ?? e)),
              stats: { fuelUsed: polls, peakMemoryBytes: peak },
            }));
          }
        }
        pump();
      } catch (e) {
        enginePromise = null;
        if (!done) {
          done = true;
          if (timer) clearTimeout(timer);
          live.delete(abort);
          resolveEval({
            success: false,
            error: errorFrom('EngineError', 'WASM engine fault: ' + (e?.message ?? e)),
            stats: { fuelUsed: polls, peakMemoryBytes: peak },
          });
        }
      }
    });
  }

  // ── Message handler ──

  self.onmessage = async ({ data: msg }) => {
    switch (msg.type) {
      case 'configure': {
        if (msg.importMap) importMap = msg.importMap;
        if (msg.virtualModules) {
          for (const [name, src] of Object.entries(msg.virtualModules)) virtualModules.set(name, src);
        }
        config = msg.wasm;
        try {
          await getEngine();
          self.postMessage({ type: 'configured' });
        } catch (e) {
          self.postMessage({ type: 'configured', error: { message: String(e?.message ?? e) } });
        }
        break;
      }
      case 'defineModule': {
        virtualModules.set(msg.name, msg.source);
        self.postMessage({ type: 'moduleDefined', name: msg.name });
        break;
      }
      case 'evaluate': {
        const res = await runEval(msg);
        self.postMessage({ type: 'result', id: msg.id, nonce: msg.nonce, ...res });
        break;
      }
      case 'capabilityResult': {
        const p = pendingRpc.get(msg.id);
        if (p) {
          pendingRpc.delete(msg.id);
          if (msg.success) p.resolve(msg.value);
          else p.reject(new Error(msg.error || 'Capability call failed'));
        }
        break;
      }
      case 'dispose': {
        for (const abort of [...live]) abort('Sandbox disposed');
        pendingRpc.clear();
        self.close();
        break;
      }
    }
  };
}

/**
 * Generate the Worker source for `mode: 'wasm'` as a string.
 *
 * @returns {string} The Worker script source code.
 */
export function makeWasmWorkerSource() {
  return `'use strict';\n(${wasmWorkerMain.toString()})();\n`;
}
