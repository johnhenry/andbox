/**
 * #46: createSandbox({ bridges }) -- host APIs shared with sandboxed code.
 *
 * These run the real runtime on node:worker_threads (the same script a browser
 * Worker runs). test/browser/bridges.spec.mjs covers browser Workers and
 * mode: 'iframe'.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox, defineBridge, makeWorkerSource } from '../src/index.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

/** Wait until `fn()` is truthy (host-side bookkeeping settles asynchronously). */
async function until(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await tick(5);
  }
}

/**
 * A fake host API: a "chat" service with sessions (handles), a streaming
 * method, an abortable slow method and a progress callback. It records what
 * happens on the host so tests can check lifetime and cancellation.
 */
function fakeService() {
  const log = { created: 0, destroyed: [], aborted: [], cancelled: 0, seenSignal: [] };
  class Session {
    constructor(id, prefix) { this.id = id; this.prefix = prefix; this.usage = 0; this.destroyed = false; }
    async ask(text, opts = {}) {
      log.seenSignal.push(opts.signal instanceof AbortSignal);
      this.usage += text.length;
      return `${this.prefix}${text}`;
    }
    async *askStreaming(text) {
      try {
        for (const word of text.split(' ')) {
          this.usage += word.length;
          yield word;
        }
      } finally {
        if (this.usage >= 0) log.streamFinally = (log.streamFinally ?? 0) + 1;
      }
    }
    slow(signal) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve('done'), 5000);
        signal.addEventListener('abort', () => { clearTimeout(t); log.aborted.push(this.id); reject(signal.reason); }, { once: true });
      });
    }
    destroy() { this.destroyed = true; log.destroyed.push(this.id); }
  }
  let seq = 0;
  const bridge = (extra = {}) => ({
    api: {
      version: () => '1.0',
      echo: (ctx, ...args) => args,
      chat: {
        create: {
          handle: true,
          async call(ctx, options = {}) {
            if (typeof options.onProgress === 'function') {
              for (const loaded of [0, 0.5, 1]) await options.onProgress({ loaded });
            }
            log.created++;
            return ctx.handle('Session', new Session(++seq, options.prefix ?? '> '));
          },
        },
      },
      count: {
        stream: true,
        call(ctx, n) {
          const signal = ctx.signal;
          return new ReadableStream({
            i: 0,
            pull(controller) {
              this.i = (this.i ?? 0) + 1;
              if (this.i > n) controller.close();
              else controller.enqueue(this.i);
            },
            cancel() { log.cancelled++; log.cancelSignal = signal.aborted; },
          });
        },
      },
      // Reverse calls: the host calls a function the sandbox passed in.
      async map(ctx, items, fn) { return Promise.all(items.map((x) => fn(x))); },
      waitForSignal(ctx) {
        return new Promise((resolve, reject) => {
          ctx.signal.addEventListener('abort', () => { log.aborted.push('top'); reject(ctx.signal.reason); }, { once: true });
        });
      },
      leak: () => ({ fn: Symbol('x') }),
      big: (ctx, n) => 'x'.repeat(n),
    },
    handles: {
      Session: {
        methods: {
          ask: (ctx, text, opts) => ctx.target.ask(text, { ...opts, signal: ctx.signal }),
          askStreaming: { stream: true, call: (ctx, text) => ctx.target.askStreaming(text) },
          slow: (ctx) => ctx.target.slow(ctx.signal),
          clone: { handle: true, call: (ctx) => ctx.handle('Session', new Session(++seq, ctx.target.prefix)) },
        },
        props: ['id', 'usage'],
        destroy: (s) => s.destroy(),
      },
    },
    ...extra,
  });
  return { log, bridge };
}

describe('#46 bridges: default behaviour is unchanged', () => {
  it('makeWorkerSource() without bridges is the same script as before', () => {
    assert.equal(makeWorkerSource(), makeWorkerSource({ bridges: false }));
    assert.ok(!makeWorkerSource().includes('installBridges'));
    assert.ok(makeWorkerSource({ bridges: true }).includes('installBridges'));
  });
});

describe('#46 bridges: methods', () => {
  it('installs a global whose methods call the host, args and results by structured clone', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const d = new Date(0);
      const [a, b, c] = await svc.echo(1, { m: new Map([[1, 2]]) }, d);
      return { typeofSvc: typeof svc, version: await svc.version(), a, b: b.m.get(1), c: c instanceof Date };
    `);
    assert.deepEqual(r, { typeofSvc: 'object', version: '1.0', a: 1, b: 2, c: true });
  });

  it('libraries see the global too (it is on globalThis)', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    await sb.defineModule('lib', 'export const v = () => globalThis.svc.version();');
    assert.equal(await sb.evaluate(`return (await sandboxImport('lib')).v();`), '1.0');
  });

  it('host errors reject in the sandbox with their name and message, never the host stack', async () => {
    const sb = await make({
      bridges: {
        svc: {
          api: {
            fail() { throw new RangeError('nope'); },
            dom() { throw new DOMException('quota', 'QuotaExceededError'); },
          },
        },
      },
    });
    const r = await sb.evaluate(`
      const out = [];
      for (const m of ['fail', 'dom']) {
        try { await svc[m](); } catch (e) { out.push([e.name, e.message, e instanceof RangeError, String(e.stack ?? '').includes('bridges.test')]); }
      }
      return out;
    `);
    assert.deepEqual(r, [['RangeError', 'nope', true, false], ['QuotaExceededError', 'quota', false, false]]);
  });

  it('a result that cannot be cloned rejects with DataCloneError instead of leaking a host object', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`try { await svc.leak(); return 'no'; } catch (e) { return [e.name, /structured-clone/.test(e.message)]; }`);
    assert.deepEqual(r, ['DataCloneError', true]);
  });

  it('host.call() cannot reach bridge methods by their gate names', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    await assert.rejects(() => sb.evaluate(`return host.call('svc.version')`), /Unknown capability: svc.version/);
  });
});

describe('#46 bridges: handles', () => {
  it('host objects stay on the host: the sandbox gets an object with methods, props and destroy()', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const s = await svc.chat.create({ prefix: '* ' });
      const before = s.usage;
      const answer = await s.ask('hello');
      const tag = Object.prototype.toString.call(s);
      const keys = Object.keys(s);
      globalThis.keep = s;
      return { answer, before, after: s.usage, id: s.id, tag, keys, hasPrefix: 'prefix' in s };
    `);
    assert.deepEqual(r, { answer: '* hello', before: 0, after: 5, id: 1, tag: '[object Session]', keys: ['id', 'usage'], hasPrefix: false });
    assert.equal(sb.stats().bridges.svc.handles, 1);
    assert.equal(log.seenSignal[0], true, 'host methods get an AbortSignal');

    await sb.evaluate(`keep.destroy(); try { await keep.ask('again'); } catch (e) { return e.name; }`).then((n) => assert.equal(n, 'InvalidStateError'));
    await until(() => log.destroyed.length === 1);
    assert.deepEqual(log.destroyed, [1]);
    assert.equal(sb.stats().bridges.svc.handles, 0);
  });

  it('a handle can be passed back as an argument and methods can return new handles', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const s = await svc.chat.create({ prefix: '# ' });
      const c = await s.clone();
      const [same] = await svc.echo(1).then(() => [c.id !== s.id]);
      return { same, ask: await c.ask('x') };
    `);
    assert.deepEqual(r, { same: true, ask: '# x' });
  });

  it('dispose() destroys every handle the sandbox still holds', async () => {
    const { bridge, log } = fakeService();
    const sb = await createSandbox({ bridges: { svc: bridge() } });
    await sb.evaluate(`globalThis.a = await svc.chat.create(); globalThis.b = await svc.chat.create();`);
    assert.equal(log.destroyed.length, 0);
    await sb.dispose();
    assert.deepEqual(log.destroyed.sort(), [1, 2]);
  });

  it('a timeout (restart) destroys the handles and aborts in-flight host calls', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    await sb.evaluate(`globalThis.s = await svc.chat.create();`);
    await assert.rejects(() => sb.evaluate(`return await s.slow();`, { timeoutMs: 200 }), /timed out/i);
    await until(() => log.destroyed.length === 1);
    assert.deepEqual(log.aborted, [1], 'the slow host call saw its signal abort');
    assert.deepEqual(log.destroyed, [1]);
    // The next call runs in a fresh runtime with a fresh global.
    assert.equal(await sb.evaluate(`return typeof s + ':' + (await svc.version())`), 'undefined:1.0');
  });

  it('enforces limits.maxHandles per sandbox, without creating the object', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge({ limits: { maxHandles: 2 } }) } });
    const r = await sb.evaluate(`
      const a = await svc.chat.create();
      const b = await svc.chat.create();
      let err;
      try { await svc.chat.create(); } catch (e) { err = [e.name, e.message]; }
      a.destroy();
      const c = await svc.chat.create();
      return { err, c: c.id };
    `);
    assert.equal(r.err[0], 'QuotaExceededError');
    assert.match(r.err[1], /handle limit reached \(2\)/);
    assert.equal(log.created, 3, 'the refused create() never ran on the host');
  });
});

describe('#46 bridges: streaming', () => {
  it('a host ReadableStream / async iterable arrives as a ReadableStream that is async-iterable', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const out = [];
      const rs = svc.count(4);
      const isStream = rs instanceof ReadableStream;
      for await (const n of rs) out.push(n);
      const s = await svc.chat.create();
      const words = [];
      const stream = s.askStreaming('a bb ccc');
      for await (const w of stream) words.push(w);
      return { isStream, out, words, usage: s.usage };
    `);
    assert.deepEqual(r, { isStream: true, out: [1, 2, 3, 4], words: ['a', 'bb', 'ccc'], usage: 6 });
    assert.equal(log.streamFinally, 1);
    await until(() => sb.stats().bridges.svc.streams === 0);
  });

  it('is pull-driven: the host produces only what the sandbox reads (backpressure)', async () => {
    let produced = 0;
    const sb = await make({
      bridges: {
        svc: {
          api: {
            numbers: {
              stream: true,
              call: () => ({
                async *[Symbol.asyncIterator]() { for (let i = 0; ; i++) { produced++; yield i; } },
              }),
            },
          },
        },
      },
    });
    const r = await sb.evaluate(`
      const reader = svc.numbers().getReader();
      const a = await reader.read();
      const b = await reader.read();
      await new Promise((r) => setTimeout(r, 100));
      await reader.cancel();
      return [a.value, b.value];
    `);
    assert.deepEqual(r, [0, 1]);
    assert.ok(produced <= 4, `produced ${produced} chunks for 2 reads`);
  });

  it('cancel() in the sandbox cancels the host stream and aborts its signal', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    await sb.evaluate(`
      const reader = svc.count(1000).getReader();
      await reader.read();
      await reader.cancel('enough');
    `);
    await until(() => log.cancelled === 1);
    assert.equal(log.cancelSignal, true);
    await until(() => sb.stats().bridges.svc.streams === 0);
  });

  it('enforces limits.maxStreams', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge({ limits: { maxStreams: 1 } }) } });
    const r = await sb.evaluate(`
      const a = svc.count(10).getReader();
      await a.read();
      try { await svc.count(10).getReader().read(); return 'no'; } catch (e) { return e.name; }
    `);
    assert.equal(r, 'QuotaExceededError');
  });
});

describe('#46 bridges: abort', () => {
  it('an AbortSignal in the arguments aborts the host call; the sandbox rejects with its reason', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const c = new AbortController();
      const p = svc.waitForSignal({ signal: c.signal });
      setTimeout(() => c.abort(new Error('stop')), 20);
      try { await p; } catch (e) { return e.message; }
    `);
    assert.equal(r, 'stop');
    await until(() => log.aborted.includes('top'));
    assert.equal(sb.stats().bridges.svc.pendingCalls, 0);
  });

  it('an already-aborted signal rejects without calling the host', async () => {
    let calls = 0;
    const sb = await make({ bridges: { svc: { api: { f: () => { calls++; } } } } });
    const r = await sb.evaluate(`try { await svc.f({ signal: AbortSignal.abort() }); } catch (e) { return e.name; }`);
    assert.equal(r, 'AbortError');
    assert.equal(calls, 0);
  });

  it('aborting a stream call errors the stream and cancels the host side', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({
      bridges: {
        svc: bridge({
          api: {
            ...bridge().api,
            countWith: { stream: true, call: (ctx, n, opts) => bridge().api.count.call(ctx, n) },
          },
        }),
      },
    });
    const r = await sb.evaluate(`
      const c = new AbortController();
      const reader = svc.countWith(1000, { signal: c.signal }).getReader();
      await reader.read();
      c.abort();
      try { await reader.read(); return 'no'; } catch (e) { return e.name; }
    `);
    assert.equal(r, 'AbortError');
    await until(() => log.cancelled === 1);
  });

  it('destroy() rejects pending calls on that handle and aborts them on the host', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const s = await svc.chat.create();
      const p = s.slow();
      await new Promise((r) => setTimeout(r, 20));
      s.destroy();
      try { await p; } catch (e) { return e.name; }
    `);
    assert.equal(r, 'AbortError');
    await until(() => log.aborted.includes(1));
  });

  it('limits.timeoutMs aborts a slow host call with TimeoutError', async () => {
    const { bridge, log } = fakeService();
    const sb = await make({ bridges: { svc: bridge({ limits: { timeoutMs: 50 } }) } });
    const r = await sb.evaluate(`const s = await svc.chat.create(); try { await s.slow(); } catch (e) { return [e.name, e.message]; }`);
    assert.equal(r[0], 'TimeoutError');
    assert.match(r[1], /timed out after 50ms/);
    await until(() => log.aborted.includes(1));
  });
});

describe('#46 bridges: callbacks (reverse calls)', () => {
  it('sandbox functions in arguments run in the sandbox when the host calls them', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`
      const seen = [];
      const s = await svc.chat.create({ onProgress: (p) => { seen.push(p.loaded); } });
      const doubled = await svc.map([1, 2, 3], async (x) => x * 2);
      return { seen, doubled, id: s.id };
    `);
    assert.deepEqual(r, { seen: [0, 0.5, 1], doubled: [2, 4, 6], id: 1 });
  });

  it('a callback that throws rejects the host-side call with its message', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() } });
    const r = await sb.evaluate(`try { await svc.map([1], () => { throw new TypeError('bad item'); }); } catch (e) { return e.message; }`);
    assert.equal(r, 'bad item');
  });

  it('callbacks outlive the call only when it created a handle, and are released with it', async () => {
    let saved;
    const sb = await make({
      bridges: {
        svc: {
          api: {
            keep(ctx, fn) { saved = fn; },
            open: { handle: true, call(ctx, fn) { saved = fn; return ctx.handle('Thing', {}); } },
          },
          handles: { Thing: { methods: { ping: () => saved('ping') } } },
        },
      },
    });
    await sb.evaluate(`await svc.keep(() => 'kept');`);
    await assert.rejects(() => saved(), /released/);
    const r = await sb.evaluate(`globalThis.t = await svc.open((x) => x + '!'); return t.ping();`);
    assert.equal(r, 'ping!');
    await sb.evaluate(`t.destroy();`);
    await tick(50);
    await assert.rejects(() => saved('x'), /released/);
  });

  it('pending reverse calls reject when the sandbox goes away', async () => {
    let saved;
    const sb = await createSandbox({
      bridges: { svc: { api: { open: { handle: true, call(ctx, fn) { saved = fn; return ctx.handle('T', {}); } } }, handles: { T: {} } } },
    });
    await sb.evaluate(`globalThis.t = await svc.open(() => new Promise(() => {}));`);
    const p = saved();
    await sb.dispose();
    await assert.rejects(p, /terminated/);
  });
});

describe('#46 bridges: consent (onRequest)', () => {
  it('sees bridge, method, args and handle; true allows, anything else denies with NotAllowedError', async () => {
    const { bridge } = fakeService();
    const requests = [];
    const sb = await make({
      bridges: {
        svc: bridge({
          onRequest(req) {
            requests.push({ method: req.method, args: req.args, handle: req.handle?.type ?? null, ua: req.requiresUserActivation, signal: req.signal instanceof AbortSignal });
            return req.method !== 'Session.ask' || req.args[0] !== 'forbidden';
          },
        }),
      },
    });
    const r = await sb.evaluate(`
      const s = await svc.chat.create({ prefix: '' });
      const ok = await s.ask('fine');
      try { await s.ask('forbidden'); } catch (e) { return [ok, e.name, e.message]; }
    `);
    assert.deepEqual(r, ['fine', 'NotAllowedError', 'svc.Session.ask was denied by onRequest']);
    assert.deepEqual(requests.map((q) => [q.method, q.handle]), [['chat.create', null], ['Session.ask', 'Session'], ['Session.ask', 'Session']]);
    assert.deepEqual(requests[0].args, [{ prefix: '' }]);
    assert.equal(requests[0].ua, false);
    assert.equal(requests[0].signal, true);
  });

  it('may await the user; a thrown error denies with its message; a forgotten return denies', async () => {
    let approve;
    const sb = await make({
      bridges: {
        a: { api: { f: () => 'ran' }, onRequest: () => new Promise((r) => { approve = r; }) },
        b: { api: { f: () => 'ran' }, onRequest: () => { throw new Error('ask an admin'); } },
        c: { api: { f: () => 'ran' }, onRequest: () => {} },
      },
    });
    const p = sb.evaluate(`return a.f()`);
    await until(() => approve);
    approve(true);
    assert.equal(await p, 'ran');
    assert.deepEqual(await sb.evaluate(`try { await b.f(); } catch (e) { return [e.name, e.message]; }`), ['NotAllowedError', 'ask an admin']);
    assert.deepEqual(await sb.evaluate(`try { await c.f(); } catch (e) { return e.name; }`), 'NotAllowedError');
  });

  it('requiresUserActivation is reported to onRequest, and refused when the platform says there is none', async () => {
    const ua = { isActive: false, hasBeenActive: false };
    const desc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userActivation');
    Object.defineProperty(globalThis.navigator, 'userActivation', { value: ua, configurable: true });
    try {
      const seen = [];
      const sb = await make({
        bridges: {
          svc: {
            api: {
              download: { requiresUserActivation: (ctx, kind) => kind, call: () => 'downloaded' },
              plain: () => 'ok',
            },
            onRequest(req) {
              seen.push([req.method, req.requiresUserActivation, req.userActivation?.isActive]);
              if (req.requiresUserActivation) ua.isActive = ua.hasBeenActive = req.args[1] === 'click';
              return true;
            },
          },
        },
      });
      const r = await sb.evaluate(`
        const out = [await svc.plain()];
        try { await svc.download('transient'); } catch (e) { out.push(e.name, /requires transient user activation/.test(e.message)); }
        out.push(await svc.download('sticky', 'click'));
        return out;
      `);
      assert.deepEqual(r, ['ok', 'NotAllowedError', true, 'downloaded']);
      assert.deepEqual(seen, [['plain', false, false], ['download', 'transient', false], ['download', 'sticky', false]]);
    } finally {
      if (desc) Object.defineProperty(globalThis.navigator, 'userActivation', desc);
      else delete globalThis.navigator.userActivation;
    }
  });
});

describe('#46 bridges: budgets', () => {
  it('bridge methods go through the capability gate: policy limits them and stats count them', async () => {
    const { bridge } = fakeService();
    const sb = await make({
      bridges: { svc: bridge() },
      policy: { capabilities: { 'svc.Session.ask': { maxCalls: 2 } } },
    });
    const r = await sb.evaluate(`
      const s = await svc.chat.create();
      await s.ask('a'); await s.ask('b');
      try { await s.ask('c'); } catch (e) { return e.message; }
    `);
    assert.match(r, /Capability 'svc.Session.ask' call limit exceeded \(2\)/);
    const per = sb.stats().gate.perCapability;
    assert.equal(per['svc.Session.ask'].calls, 2);
    assert.equal(per['svc.chat.create'].calls, 1);
  });

  it('a global maxArgBytes counts bridge arguments', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge() }, policy: { limits: { maxArgBytes: 100 } } });
    const r = await sb.evaluate(`try { await svc.echo('x'.repeat(200)); } catch (e) { return e.message; }`);
    assert.match(r, /Global argument byte limit exceeded/);
  });

  it('limits.maxResultBytes refuses an oversized result', async () => {
    const { bridge } = fakeService();
    const sb = await make({ bridges: { svc: bridge({ limits: { maxResultBytes: 1000 } }) } });
    const r = await sb.evaluate(`
      const ok = (await svc.big(10)).length;
      try { await svc.big(5000); } catch (e) { return [ok, e.name, e.message]; }
    `);
    assert.equal(r[0], 10);
    assert.equal(r[1], 'QuotaExceededError');
    assert.match(r[2], /5000 bytes, over limits.maxResultBytes \(1000\)/);
  });

  it('per-sandbox state and stats() from the definition', async () => {
    const sb = await make({
      bridges: {
        svc: {
          createState: () => ({ n: 0 }),
          stats: (state) => ({ n: state.n }),
          api: { inc: (ctx) => ++ctx.state.n },
        },
      },
    });
    await sb.evaluate(`await svc.inc(); await svc.inc();`);
    assert.equal(sb.stats().bridges.svc.n, 2);
  });
});

describe('#46 bridges: client adapter and aliases', () => {
  it('a client function adapts the global in the sandbox; globals add aliases', async () => {
    const sb = await make({
      bridges: {
        svc: {
          api: { math: { add: (ctx, a, b) => a + b } },
          globals: { MathService: 'math' },
          clientOptions: { greeting: 'hi' },
          client: function (api, options) {
            api.hello = () => options.greeting;
            return api;
          },
        },
      },
    });
    assert.deepEqual(await sb.evaluate(`return [svc.hello(), await MathService.add(2, 3), MathService === svc.math]`), ['hi', 5, true]);
  });
});

describe('#46 bridges: validation', () => {
  it('rejects bad definitions before starting anything', async () => {
    const bad = [
      [{ host: { api: {} } }, /not allowed as a bridge name/],
      [{ 'a-b': { api: {} } }, /not allowed as a bridge name/],
      [{ svc: { api: { then: () => {} } } }, /'then' is not allowed/],
      [{ svc: { api: { f: { call: () => {}, nope: 1 } } } }, /not a known method option/],
      [{ svc: { api: {}, limits: { maxHandles: -1 } } }, /maxHandles must be a non-negative number/],
      [{ svc: { api: {}, limits: { nope: 1 } } }, /not a known limit/],
      [{ svc: { api: {}, extra: 1 } }, /not a known bridge option/],
      [{ svc: { api: {}, handles: { T: { props: ['destroy'] } } } }, /props must be an array/],
      [{ svc: { api: {}, globals: { fetch: 'x' } } }, /not allowed as a global name/],
      [{ a: { api: {}, globals: { X: 'y' } }, b: { api: {}, globals: { X: 'z' } } }, /more than one bridge defines the global 'X'/],
      [{ svc: { api: { f: { call: () => {}, requiresUserActivation: 'maybe' } } } }, /requiresUserActivation must be/],
    ];
    for (const [bridges, re] of bad) {
      assert.throws(() => createSandbox({ bridges }), re);
    }
    assert.throws(() => defineBridge({ api: { f: 1 } }), /must be an object of methods/);
  });

  it('only worker, node-worker and iframe modes accept bridges', async () => {
    assert.throws(() => createSandbox({ mode: 'inline', bridges: {} }), /bridges option applies to/);
    assert.throws(() => createSandbox({ mode: 'wasm', bridges: {} }), /QuickJS guest/);
  });

  it('a capability with a bridge method name is refused', async () => {
    await assert.rejects(
      () => createSandbox({ capabilities: { 'svc.f': () => 1 }, bridges: { svc: { api: { f: () => 1 } } } }),
      /same name as a bridge method/
    );
  });
});
