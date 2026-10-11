/**
 * A fake of Chrome's built-in AI APIs (shapes as shipped in Chrome 148+:
 * measureContextUsage/contextUsage/contextWindow), for tests: CI has no model.
 * Used by test/chrome-ai-bridge.test.mjs (Node) and
 * test/browser/bridges.spec.mjs (installed on the page).
 *
 *   const fake = createFakeChromeAI({ availability: 'available' });
 *   chromeAI({ scope: fake.scope })   // or Object.assign(window, fake.scope)
 *
 * Tool use is modelled on Chrome 154 as measured (andbox#52):
 * - LanguageModelToolCall / ToolSuccess / ToolError inits require `callID`
 *   and throw Chrome's TypeError without it (`{ callId }` is not enough).
 * - Their instances have no own properties, only prototype getters (`callID`,
 *   `name`, `arguments` / `result` / `errorMessage`): `JSON.stringify` gives
 *   '{}', and structuredClone / postMessage throw DataCloneError.
 * - A tool call the model makes has `callID` '' (what Chrome returns), unless
 *   `toolCallID` says otherwise.
 * - create() with tools throws unless expectedOutputs includes
 *   { type: 'tool-call' }.
 */
export function createFakeChromeAI({ availability = 'available', contextWindow = 1000, toolCallID = '' } = {}) {
  const log = { created: [], destroyed: [], prompts: [], aborted: 0, createOptions: [], toolResponses: [], toolCalls: [] };
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
      if (Array.isArray(options.tools) && options.tools.length
        && !(options.expectedOutputs ?? []).some((o) => o?.type === 'tool-call')) {
        throw new TypeError('When tools are provided, expectedOutputs must include {type: "tool-call"}');
      }
      for (const m of options.initialPrompts ?? []) {
        for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c.type === 'tool-call') {
            if (!(c.value instanceof LanguageModelToolCall)) throw new TypeError("Failed to read the 'value' property: not a LanguageModelToolCall");
            log.toolCalls.push({ callID: c.value.callID, name: c.value.name, arguments: c.value.arguments });
          }
        }
      }
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
            { type: 'tool-call', value: new LanguageModelToolCall({ callID: toolCallID, name: this.tools[0].name, arguments: { q: 1 } }) },
          ];
        }
        if (Array.isArray(input)) {
          const resp = input.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool-response');
          if (resp) {
            const v = resp.value;
            if (v instanceof LanguageModelToolSuccess) {
              log.toolResponses.push({ kind: 'success', callID: v.callID, name: v.name, result: v.result });
              return `tool said ${JSON.stringify(v.result)}`;
            }
            if (v instanceof LanguageModelToolError) {
              log.toolResponses.push({ kind: 'error', callID: v.callID, name: v.name, errorMessage: v.errorMessage });
              return `tool failed: ${v.errorMessage}`;
            }
            return 'not converted';
          }
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

  // Platform objects: the fields live outside the object and are read through
  // prototype getters; the instance is a Proxy so structured clone refuses it
  // (DataCloneError) as it refuses a real platform object.
  const fields = new WeakMap();
  function platformObject(self, init, dictionary, members) {
    if (init === null || typeof init !== 'object') throw new TypeError(`Failed to construct: parameter 1 is not of type '${dictionary}'.`);
    if (init.callID === undefined) {
      throw new TypeError(`Failed to read the 'callID' property from '${dictionary}': Required member is undefined.`);
    }
    const data = { callID: String(init.callID) };
    for (const m of members) data[m] = init[m];
    const proxy = new Proxy(self, {});
    fields.set(proxy, data);
    return proxy;
  }
  const getter = (name) => function () { return fields.get(this)?.[name]; };
  function defineGetters(C, names) {
    for (const n of names) Object.defineProperty(C.prototype, n, { get: getter(n), enumerable: true, configurable: true });
  }
  class LanguageModelToolCall {
    constructor(init) { return platformObject(this, init, 'LanguageModelToolCallInit', ['name', 'arguments']); }
  }
  defineGetters(LanguageModelToolCall, ['callID', 'name', 'arguments']);
  class LanguageModelToolSuccess {
    constructor(init) { return platformObject(this, init, 'LanguageModelToolSuccessInit', ['name', 'result']); }
  }
  defineGetters(LanguageModelToolSuccess, ['callID', 'name', 'result']);
  class LanguageModelToolError {
    constructor(init) { return platformObject(this, init, 'LanguageModelToolErrorInit', ['name', 'errorMessage']); }
  }
  defineGetters(LanguageModelToolError, ['callID', 'name', 'errorMessage']);

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
    scope: { LanguageModel, LanguageModelToolCall, LanguageModelToolSuccess, LanguageModelToolError, Summarizer, LanguageDetector },
  };
}
