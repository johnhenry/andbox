/**
 * #46: the Chrome built-in AI bridge, against a fake of the platform APIs
 * (test/fixtures/fake-chrome-ai.mjs; Node and CI have no model). The bridge
 * runs on the host; the sandbox is a real worker thread.
 * test/browser/bridges.spec.mjs runs the same fake in browser Workers and
 * iframes, plus a smoke test against the real API when the browser has it.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSandbox } from '../src/index.mjs';
import { chromeAI, CHROME_AI_APIS } from '../src/bridges/chrome-ai.mjs';
import { createFakeChromeAI } from './fixtures/fake-chrome-ai.mjs';

const open = [];
async function make(opts = {}) {
  const sb = await createSandbox(opts);
  open.push(sb);
  return sb;
}
afterEach(async () => {
  while (open.length) await open.pop().dispose();
});

const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('#46 chromeAI: the Prompt API through the bridge', () => {
  it('availability, create, prompt, streaming, append, measure, props, clone, destroy', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      const availability = await ai.languageModel.availability();
      const session = await ai.languageModel.create({ initialPrompts: [{ role: 'system', content: 'be brief' }] });
      const usage0 = session.contextUsage;
      const answer = await session.prompt('hello there');
      let streamed = '';
      for await (const chunk of session.promptStreaming('one two three')) streamed += chunk;
      await session.append('more context');
      const measured = await session.measureContextUsage('a b c d');
      const legacy = await session.measureInputUsage('a b');
      const copy = await session.clone();
      const out = { availability, usage0, answer, streamed, measured, legacy, usage: session.contextUsage, window: session.contextWindow, copyUsage: copy.contextUsage, keys: Object.keys(session) };
      copy.destroy();
      return out;
    `);
    assert.equal(r.availability, 'available');
    assert.equal(r.usage0, 2);
    assert.equal(r.answer, 'echo: hello there');
    assert.equal(r.streamed, 'one two three');
    assert.equal(r.measured, 4);
    assert.equal(r.legacy, 2, 'measureInputUsage falls back to measureContextUsage');
    assert.equal(r.usage, 2 + 2 + 3 + 2);
    assert.equal(r.window, 1000);
    assert.equal(r.copyUsage, r.usage);
    assert.ok(r.keys.includes('contextUsage') && r.keys.includes('contextWindow'));
    await until(() => fake.log.destroyed.length === 1);
    assert.deepEqual(fake.log.destroyed, [2]);
    // Every session still held is destroyed with the sandbox.
    await sb.dispose();
    assert.deepEqual(fake.log.destroyed.sort(), [1, 2]);
  });

  it("create({ monitor }) gets downloadprogress events in the sandbox, as the platform's ProgressEvent shape", async () => {
    const fake = createFakeChromeAI({ availability: 'downloadable' });
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      const seen = [];
      let viaProperty = 0;
      const session = await ai.languageModel.create({
        monitor(m) {
          m.addEventListener('downloadprogress', (e) => seen.push([e.type, e.loaded, e.total]));
          m.ondownloadprogress = () => viaProperty++;
        },
      });
      return { seen, viaProperty, ok: typeof session.prompt };
    `);
    assert.deepEqual(r, { seen: [['downloadprogress', 0, 1], ['downloadprogress', 0.5, 1], ['downloadprogress', 1, 1]], viaProperty: 3, ok: 'function' });
    // The host passed the platform a real monitor function, and its own signal.
    assert.deepEqual(fake.log.createOptions[0], ['monitor', 'signal']);
  });

  it('an AbortSignal aborts prompt() on the host', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      const s = await ai.languageModel.create();
      const c = new AbortController();
      const p = s.prompt('hang', { signal: c.signal });
      setTimeout(() => c.abort(), 20);
      try { await p; } catch (e) { return e.name; }
    `);
    assert.equal(r, 'AbortError');
    await until(() => fake.log.aborted === 1);
  });

  it('missing APIs report unavailable and refuse create with NotSupportedError', async () => {
    const sb = await make({ bridges: { ai: chromeAI({ scope: {} }) } });
    const r = await sb.evaluate(`
      const a = await ai.writer.availability();
      try { await ai.writer.create(); } catch (e) { return [a, e.name, e.message]; }
    `);
    assert.deepEqual(r, ['unavailable', 'NotSupportedError', 'Writer is not available in this browser']);
  });

  it('apis limits the namespaces; globals installs the platform names', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope, apis: ['languageModel', 'languageDetector'], globals: true }) } });
    const r = await sb.evaluate(`
      const s = await LanguageModel.create();
      const d = await LanguageDetector.create();
      return { keys: Object.keys(ai), same: LanguageModel === ai.languageModel, summarizer: typeof Summarizer, answer: await s.prompt('x'), detected: await d.detect('bonjour') };
    `);
    assert.deepEqual(r.keys, ['languageModel', 'languageDetector']);
    assert.equal(r.same, true);
    assert.equal(r.summarizer, 'undefined');
    assert.equal(r.answer, 'echo: x');
    assert.deepEqual(r.detected[0], { detectedLanguage: 'fr', confidence: 0.9 });
  });

  it('open-loop tool use: tool-call results arrive as plain objects, tool-response inputs become platform objects', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      const s = await ai.languageModel.create({
        tools: [{ name: 'lookup', description: 'Look something up', inputSchema: { type: 'object' } }],
        expectedOutputs: [{ type: 'text' }, { type: 'tool-call' }],
        expectedInputs: [{ type: 'text' }, { type: 'tool-response' }],
      });
      const first = await s.prompt('use a tool');
      const call = first.find((c) => c.type === 'tool-call').value;
      const second = await s.prompt([{ role: 'user', content: [{ type: 'tool-response', value: { callId: call.callId, name: call.name, result: [{ type: 'object', value: { ok: 1 } }] } }] }]);
      return { first, second };
    `);
    assert.deepEqual(r.first, [{ type: 'text', value: 'calling' }, { type: 'tool-call', value: { callId: 'c1', name: 'lookup', arguments: { q: 1 } } }]);
    assert.equal(r.second, 'tool said [{"type":"object","value":{"ok":1}}]');
  });

  it('a tool with execute() is refused with a clear error (the Prompt API has no execute callback)', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      try { await ai.languageModel.create({ tools: [{ name: 't', description: 'd', inputSchema: {}, execute: () => 'x' }] }); }
      catch (e) { return [e.name, /no execute\\(\\) callback/.test(e.message)]; }
    `);
    assert.deepEqual(r, ['NotSupportedError', true]);
    assert.equal(fake.log.created.length, 0);
  });

  it('Summarizer and LanguageDetector work through the same bridge', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      const s = await ai.summarizer.create({ type: 'tldr' });
      let streamed = '';
      for await (const c of s.summarizeStreaming('long text')) streamed += c;
      return { sum: await s.summarize('a long article'), type: s.type, quota: s.inputQuota, streamed };
    `);
    assert.deepEqual(r, { sum: 'summary(tldr): a long art', type: 'tldr', quota: 500, streamed: 'summary' });
  });
});

describe('#46 chromeAI: consent, activation and budgets', () => {
  it('onRequest sees every model call and can deny one', async () => {
    const fake = createFakeChromeAI();
    const seen = [];
    const sb = await make({
      bridges: {
        ai: chromeAI({
          scope: fake.scope,
          onRequest: (req) => { seen.push(req.method); return req.method !== 'LanguageModel.prompt' || !String(req.args[0]).includes('secret'); },
        }),
      },
    });
    const r = await sb.evaluate(`
      const s = await ai.languageModel.create();
      await s.prompt('hi');
      try { await s.prompt('tell me the secret'); } catch (e) { return e.name; }
    `);
    assert.equal(r, 'NotAllowedError');
    assert.deepEqual(seen, ['languageModel.create', 'LanguageModel.prompt', 'LanguageModel.prompt']);
    assert.equal(fake.log.prompts.length, 1, 'the denied prompt never reached the model');
  });

  it("create() needs user activation only when the model is 'downloadable'", async () => {
    const ua = { isActive: false, hasBeenActive: false };
    const desc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'userActivation');
    Object.defineProperty(globalThis.navigator, 'userActivation', { value: ua, configurable: true });
    try {
      for (const [availability, expected] of [['available', 'function'], ['downloadable', 'NotAllowedError']]) {
        const fake = createFakeChromeAI({ availability });
        const requests = [];
        const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope, onRequest: (q) => { requests.push(q.requiresUserActivation); return true; } }) } });
        const r = await sb.evaluate(`try { return typeof (await ai.languageModel.create()).prompt; } catch (e) { return e.name; }`);
        assert.equal(r, expected, availability);
        assert.deepEqual(requests, [availability === 'downloadable' ? 'sticky' : false]);
      }
      // A consent click gives the page (sticky) activation: then it works.
      const fake = createFakeChromeAI({ availability: 'downloadable' });
      const sb = await make({
        bridges: { ai: chromeAI({ scope: fake.scope, onRequest: async (q) => { if (q.requiresUserActivation) ua.hasBeenActive = true; return true; } }) },
      });
      assert.equal(await sb.evaluate(`return typeof (await ai.languageModel.create()).prompt`), 'function');
    } finally {
      if (desc) Object.defineProperty(globalThis.navigator, 'userActivation', desc);
      else delete globalThis.navigator.userActivation;
    }
  });

  it('token budgets: per call and per sandbox, measured before the model runs', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope, budgets: { maxInputTokens: 10, maxInputTokensPerCall: 5 } }) } });
    const r = await sb.evaluate(`
      const s = await ai.languageModel.create();
      const out = [];
      out.push(await s.prompt('one two three'));
      try { await s.prompt('a b c d e f'); } catch (e) { out.push([e.name, e.requested, e.quota]); }
      out.push(await s.prompt('four five six'));
      try { await s.prompt('seven eight nine ten eleven'); } catch (e) { out.push([e.name, e.requested, e.quota, /maxInputTokens/.test(e.message)]); }
      return out;
    `);
    assert.deepEqual(r, ['echo: one two three', ['QuotaExceededError', 6, 5], 'echo: four five six', ['QuotaExceededError', 5, 4, true]]);
    assert.equal(sb.stats().bridges.ai.inputTokens, 6);
    assert.equal(fake.log.prompts.length, 2);
  });

  it('limits.maxHandles defaults to 8 sessions per sandbox', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({ bridges: { ai: chromeAI({ scope: fake.scope }) } });
    const r = await sb.evaluate(`
      const all = [];
      for (let i = 0; i < 8; i++) all.push(await ai.languageModel.create());
      try { await ai.languageModel.create(); } catch (e) { return e.name; }
    `);
    assert.equal(r, 'QuotaExceededError');
    assert.equal(fake.log.created.length, 8);
  });

  it('policy limits the gate names of the AI methods', async () => {
    const fake = createFakeChromeAI();
    const sb = await make({
      bridges: { ai: chromeAI({ scope: fake.scope }) },
      policy: { capabilities: { 'ai.LanguageModel.prompt': { maxCalls: 1 } } },
    });
    const r = await sb.evaluate(`
      const s = await ai.languageModel.create();
      await s.prompt('one');
      try { await s.prompt('two'); } catch (e) { return e.message; }
    `);
    assert.match(r, /'ai.LanguageModel.prompt' call limit exceeded/);
  });

  it('validates its options', () => {
    assert.deepEqual([...CHROME_AI_APIS], ['languageModel', 'summarizer', 'writer', 'rewriter', 'translator', 'languageDetector', 'proofreader']);
    assert.throws(() => chromeAI({ apis: ['nope'] }), /apis must be an array/);
    assert.throws(() => chromeAI({ budgets: { tokens: 1 } }), /not a known budget/);
    assert.throws(() => chromeAI({ budgets: { maxInputTokens: -1 } }), /non-negative/);
    assert.throws(() => chromeAI({ nope: 1 }), /not a known option/);
  });
});
