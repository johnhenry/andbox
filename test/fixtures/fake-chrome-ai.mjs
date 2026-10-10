/**
 * A fake of Chrome's built-in AI APIs (shapes as shipped in Chrome 148+:
 * measureContextUsage/contextUsage/contextWindow), for tests: CI has no model.
 * Used by test/chrome-ai-bridge.test.mjs (Node) and
 * test/browser/bridges.spec.mjs (installed on the page).
 *
 *   const fake = createFakeChromeAI({ availability: 'available' });
 *   chromeAI({ scope: fake.scope })   // or Object.assign(window, fake.scope)
 */
export function createFakeChromeAI({ availability = 'available', contextWindow = 1000 } = {}) {
  const log = { created: [], destroyed: [], prompts: [], aborted: 0, createOptions: [] };
  const tokens = (input) => (typeof input === 'string' ? input : JSON.stringify(input)).split(/\s+/).filter(Boolean).length;

  function abortable(signal, work) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { log.aborted++; reject(signal.reason); return; }
      const onAbort = () => { log.aborted++; reject(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(work).then(
        (v) => { signal?.removeEventListener('abort', onAbort); resolve(v); },
        (e) => { signal?.removeEventListener('abort', onAbort); reject(e); },
      );
    });
  }

  async function simulateDownload(options) {
    if (typeof options?.monitor === 'function') {
      const m = new EventTarget();
      options.monitor(m);
      for (const loaded of [0, 0.5, 1]) {
        const e = new Event('downloadprogress');
        Object.assign(e, { loaded, total: 1 });
        m.dispatchEvent(e);
      }
    }
  }

  let seq = 0;
  class LanguageModel extends EventTarget {
    #destroyed = false;
    constructor(options = {}) {
      super();
      this.id = ++seq;
      this.contextUsage = options.initialPrompts ? tokens(options.initialPrompts.map((p) => p.content)) : 0;
      this.contextWindow = contextWindow;
      this.tools = options.tools ?? null;
    }
    static async availability() { return availability; }
    static async create(options = {}) {
      log.createOptions.push(Object.keys(options).sort());
      if (availability === 'unavailable') throw new DOMException('The model is not available', 'NotSupportedError');
      await simulateDownload(options);
      if (options.signal?.aborted) throw options.signal.reason;
      const s = new LanguageModel(options);
      log.created.push(s.id);
      return s;
    }
    #check() { if (this.#destroyed) throw new DOMException('The session has been destroyed', 'InvalidStateError'); }
    async measureContextUsage(input) { this.#check(); return tokens(input); }
    prompt(input, options = {}) {
      this.#check();
      log.prompts.push(input);
      return abortable(options.signal, async () => {
        if (input === 'hang') await new Promise(() => {});
        this.contextUsage += tokens(input);
        if (this.tools && input === 'use a tool') {
          return [
            { type: 'text', value: 'calling' },
            { type: 'tool-call', value: new LanguageModelToolCall({ callId: 'c1', name: this.tools[0].name, arguments: { q: 1 } }) },
          ];
        }
        if (Array.isArray(input)) {
          const resp = input.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool-response');
          if (resp) return `tool said ${resp.value instanceof LanguageModelToolSuccess ? JSON.stringify(resp.value.result) : 'not converted'}`;
        }
        return `echo: ${input}`;
      });
    }
    promptStreaming(input, options = {}) {
      this.#check();
      const words = String(input).split(' ');
      let i = 0;
      const self = this;
      return new ReadableStream({
        pull(controller) {
          if (options.signal?.aborted) { controller.error(options.signal.reason); return; }
          if (i < words.length) { self.contextUsage += 1; controller.enqueue((i ? ' ' : '') + words[i++]); }
          else controller.close();
        },
        cancel() { log.aborted++; },
      });
    }
    async append(input) { this.#check(); this.contextUsage += tokens(input); }
    async clone() { this.#check(); const c = new LanguageModel(); c.contextUsage = this.contextUsage; log.created.push(c.id); return c; }
    destroy() { this.#destroyed = true; log.destroyed.push(this.id); }
  }

  class LanguageModelToolCall {
    constructor({ callId, name, arguments: args }) { this.callId = callId; this.name = name; this.arguments = args; }
  }
  class LanguageModelToolSuccess {
    constructor({ callId, name, result }) { this.callId = callId; this.name = name; this.result = result; }
  }

  class Summarizer {
    constructor(options) { this.type = options.type ?? 'key-points'; this.format = options.format ?? 'markdown'; this.length = options.length ?? 'short'; this.inputQuota = 500; this.sharedContext = options.sharedContext ?? ''; }
    static async availability() { return availability; }
    static async create(options = {}) { await simulateDownload(options); return new Summarizer(options); }
    async summarize(input, options = {}) { return abortable(options.signal, () => `summary(${this.type}): ${String(input).slice(0, 10)}`); }
    summarizeStreaming(input) { return ReadableStream.from ? ReadableStream.from(['sum', 'mary']) : new ReadableStream({ start(c) { c.enqueue('sum'); c.enqueue('mary'); c.close(); } }); }
    async measureInputUsage(input) { return tokens(input); }
    destroy() { log.destroyed.push('summarizer'); }
  }

  class LanguageDetector {
    constructor() { this.inputQuota = 100; this.expectedInputLanguages = null; }
    static async availability() { return availability; }
    static async create() { return new LanguageDetector(); }
    async detect(input) { return [{ detectedLanguage: /bonjour/i.test(input) ? 'fr' : 'en', confidence: 0.9 }, { detectedLanguage: 'und', confidence: 0.1 }]; }
    async measureInputUsage(input) { return tokens(input); }
    destroy() { log.destroyed.push('detector'); }
  }

  return {
    log,
    scope: { LanguageModel, LanguageModelToolCall, LanguageModelToolSuccess, Summarizer, LanguageDetector },
  };
}
