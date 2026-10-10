/**
 * 10 — Bridges share a host API with sandboxed code.
 *
 * Demonstrates: createSandbox({ bridges }) gives the sandbox a global (`notes`
 * here) that proxies a host API without handing over a single host object.
 * The sandbox holds an opaque handle to a host-side notebook, streams its
 * entries, aborts a slow call with an AbortSignal, passes a function the host
 * calls back, is refused by the host's consent hook, and every notebook it
 * still holds is closed on the host when the sandbox is disposed.
 *
 * Runs under plain Node (the sandbox is a worker thread). The "host API" is a
 * small in-memory notebook service; the same mechanism backs the Chrome AI
 * bridge (`@johnhenry/andbox/bridges/chrome-ai`, example 11).
 */

import assert from 'node:assert/strict';
import { createSandbox, defineBridge } from '../src/index.mjs';

// ── The host API: an in-memory notebook service. ──
const closed = [];
class Notebook {
  constructor(name) { this.name = name; this.entries = []; }
  add(text) { this.entries.push(text); return this.entries.length; }
  async *read() { for (const e of this.entries) yield e; }
  close() { closed.push(this.name); }
}

const consentLog = [];
const notes = defineBridge({
  api: {
    // A method that returns a handle: the Notebook stays on the host.
    open: { handle: true, call: (ctx, name) => ctx.handle('Notebook', new Notebook(name)) },
    // A host call the sandbox can abort; ctx.signal also aborts on dispose.
    slowSearch: (ctx, query) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(`results for ${query}`), 10_000);
      ctx.signal.addEventListener('abort', () => { clearTimeout(t); reject(ctx.signal.reason); }, { once: true });
    }),
    // A reverse call: `format` is a sandbox function; it runs in the sandbox.
    async render(ctx, items, format) { return Promise.all(items.map((x) => format(x))); },
  },
  handles: {
    Notebook: {
      methods: {
        add: (ctx, text) => ctx.target.add(text),
        // A stream: the sandbox gets a ReadableStream, pulled chunk by chunk.
        read: { stream: true, call: (ctx) => ctx.target.read() },
      },
      props: ['name'],
      destroy: (notebook) => notebook.close(),
    },
  },
  limits: { maxHandles: 4 },
  // Consent: asked on the host before every call. Only `true` allows.
  onRequest({ method, args }) {
    consentLog.push(method);
    return !(method === 'Notebook.add' && String(args[0]).includes('password'));
  },
});

const sandbox = await createSandbox({
  bridges: { notes },
  policy: { capabilities: { 'notes.Notebook.add': { maxCalls: 10 } } }, // the usual gate applies
});

const result = await sandbox.evaluate(`
  const book = await notes.open('ideas');
  await book.add('bridges keep host objects on the host');
  await book.add('streams are pulled, not pushed');

  const read = [];
  for await (const entry of book.read()) read.push(entry);

  let denied;
  try { await book.add('my password is hunter2'); } catch (e) { denied = e.name; }

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  let aborted;
  try { await notes.slowSearch('anything', { signal: controller.signal }); } catch (e) { aborted = e.name; }

  const rendered = await notes.render(read, (s) => '- ' + s);
  globalThis.kept = await notes.open('scratch'); // still open when the sandbox is disposed
  return { name: book.name, read, denied, aborted, rendered, isPlainObject: Object.getPrototypeOf(book) === Object.prototype };
`);

assert.equal(result.name, 'ideas');
assert.deepEqual(result.read, ['bridges keep host objects on the host', 'streams are pulled, not pushed']);
assert.equal(result.denied, 'NotAllowedError');
assert.equal(result.aborted, 'AbortError');
assert.deepEqual(result.rendered, ['- bridges keep host objects on the host', '- streams are pulled, not pushed']);
assert.equal(result.isPlainObject, true, 'the sandbox holds a proxy object, not the Notebook');
console.log('sandbox saw   :', result);
console.log('consent asked :', consentLog.join(', '));

const stats = sandbox.stats();
assert.equal(stats.bridges.notes.handles, 2);
assert.equal(stats.gate.perCapability['notes.Notebook.add'].calls, 3);
console.log('live handles  :', stats.bridges.notes.handles);

await sandbox.dispose();
assert.deepEqual(closed.sort(), ['ideas', 'scratch']);
console.log('closed on dispose:', closed.join(', '));
console.log('OK');
