/**
 * Chrome built-in AI bridge (andbox#46).
 *
 *   import { chromeAI } from '@johnhenry/andbox/bridges/chrome-ai';
 *   const sandbox = await createSandbox({ bridges: { ai: chromeAI({ onRequest }) } });
 *   await sandbox.evaluate(`
 *     const session = await ai.languageModel.create();
 *     return session.prompt('Hello');
 *   `);
 *
 * Chrome exposes its built-in AI APIs (LanguageModel, Summarizer, Writer,
 * Rewriter, Translator, LanguageDetector, Proofreader) to Window contexts only:
 * not to Workers, and not to a sandboxed opaque-origin iframe (permissions
 * policy features default to 'self'). So sandboxed code reaches them only
 * through the page, which is what this bridge does: the page owns every model
 * session; the sandbox holds handles to them.
 *
 * Zero dependencies. The sandbox-side surface mirrors the platform's names
 * and shapes (see README "Chrome AI bridge" for the differences).
 */

import { defineBridge } from '../bridge-host.mjs';

/**
 * The APIs this bridge knows. `global` is the platform constructor on the
 * host; `methods` are instance methods (`input`: argument 0 is the model
 * input, counted by token budgets; `opts`: index of the options argument,
 * which gets the call's AbortSignal).
 */
const API_TABLE = {
  languageModel: {
    global: 'LanguageModel',
    methods: {
      prompt: { input: true, opts: 1 },
      promptStreaming: { input: true, opts: 1, stream: true },
      append: { input: true, opts: 1 },
      measureContextUsage: { opts: 1, alias: 'measureInputUsage' },
      measureInputUsage: { opts: 1, alias: 'measureContextUsage' },
      clone: { opts: 0, handle: true },
    },
    props: ['contextUsage', 'contextWindow', 'inputUsage', 'inputQuota', 'samplingMode', 'topK', 'temperature'],
  },
  summarizer: {
    global: 'Summarizer',
    methods: {
      summarize: { input: true, opts: 1 },
      summarizeStreaming: { input: true, opts: 1, stream: true },
      measureInputUsage: { opts: 1 },
    },
    props: ['sharedContext', 'type', 'format', 'length', 'expectedInputLanguages', 'expectedContextLanguages', 'outputLanguage', 'inputQuota'],
  },
  writer: {
    global: 'Writer',
    methods: {
      write: { input: true, opts: 1 },
      writeStreaming: { input: true, opts: 1, stream: true },
      measureInputUsage: { opts: 1 },
    },
    props: ['sharedContext', 'tone', 'format', 'length', 'expectedInputLanguages', 'expectedContextLanguages', 'outputLanguage', 'inputQuota'],
  },
  rewriter: {
    global: 'Rewriter',
    methods: {
      rewrite: { input: true, opts: 1 },
      rewriteStreaming: { input: true, opts: 1, stream: true },
      measureInputUsage: { opts: 1 },
    },
    props: ['sharedContext', 'tone', 'format', 'length', 'expectedInputLanguages', 'expectedContextLanguages', 'outputLanguage', 'inputQuota'],
  },
  translator: {
    global: 'Translator',
    methods: {
      translate: { input: true, opts: 1 },
      translateStreaming: { input: true, opts: 1, stream: true },
      measureInputUsage: { opts: 1 },
    },
    props: ['sourceLanguage', 'targetLanguage', 'inputQuota'],
  },
  languageDetector: {
    global: 'LanguageDetector',
    methods: {
      detect: { input: true, opts: 1 },
      measureInputUsage: { opts: 1 },
    },
    props: ['expectedInputLanguages', 'inputQuota'],
  },
  proofreader: {
    global: 'Proofreader',
    methods: {
      proofread: { input: true, opts: 1 },
      measureInputUsage: { opts: 1 },
    },
    props: ['includeCorrectionTypes', 'includeCorrectionExplanations', 'expectedInputLanguages', 'correctionExplanationLanguage', 'inputQuota'],
  },
};

/** Every API key `chromeAI({ apis })` accepts, in order. */
export const CHROME_AI_APIS = Object.freeze(Object.keys(API_TABLE));

/** Create-option keys that never reach the platform's `availability()`. */
const NOT_FOR_AVAILABILITY = new Set(['signal', 'monitor', 'onDownloadProgress', 'initialPrompts', 'sharedContext']);

const DEFAULT_LIMITS = Object.freeze({ maxHandles: 8, maxStreams: 4 });

function domError(message, name) {
  return new DOMException(message, name);
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkBudget(where, key, value) {
  if (value === undefined) return;
  if (!(typeof value === 'number' && Number.isFinite(value) && value >= 0)) {
    throw new TypeError(`${where}.${key} must be a non-negative number (0 = unlimited)`);
  }
}

/**
 * The sandbox-side adapter, stringified into the sandbox (no outside
 * references). Chrome's `monitor` is a synchronous callback that receives an
 * EventTarget; a function cannot cross, so the adapter calls `monitor` with a
 * local EventTarget and passes the host a progress callback instead, whose
 * calls it turns into `downloadprogress` events.
 */
function chromeAIClient(api) {
  const G = globalThis;
  const EventTargetCtor = G.EventTarget;
  const EventCtor = G.Event;
  const ProgressEventCtor = G.ProgressEvent;
  const defineProperty = Object.defineProperty;
  const keys = Object.keys;

  function progressEvent(p) {
    const init = {
      lengthComputable: true,
      loaded: p && typeof p.loaded === 'number' ? p.loaded : 0,
      total: p && typeof p.total === 'number' ? p.total : 1,
    };
    if (typeof ProgressEventCtor === 'function') return new ProgressEventCtor('downloadprogress', init);
    const e = new EventCtor('downloadprogress');
    for (const k of keys(init)) defineProperty(e, k, { value: init[k], enumerable: true });
    return e;
  }

  function makeMonitor() {
    const target = new EventTargetCtor();
    let handler = null;
    defineProperty(target, 'ondownloadprogress', {
      enumerable: true,
      get() { return handler; },
      set(fn) {
        if (handler) target.removeEventListener('downloadprogress', handler);
        handler = typeof fn === 'function' ? fn : null;
        if (handler) target.addEventListener('downloadprogress', handler);
      },
    });
    return target;
  }

  for (const key of keys(api)) {
    const ns = api[key];
    if (!ns || typeof ns.create !== 'function') continue;
    const create = ns.create;
    ns.create = function create_(options) {
      if (options !== null && typeof options === 'object' && typeof options.monitor === 'function') {
        const monitor = makeMonitor();
        options.monitor(monitor);
        const rest = {};
        for (const k of keys(options)) if (k !== 'monitor') rest[k] = options[k];
        rest.onDownloadProgress = (p) => { monitor.dispatchEvent(progressEvent(p)); };
        options = rest;
      }
      return create(options);
    };
    defineProperty(ns.create, 'name', { value: 'create' });
  }
  return api;
}

/**
 * Tool-use content (`tool-call` / `tool-response`) holds platform objects
 * (LanguageModelToolCall, LanguageModelToolSuccess, LanguageModelToolError)
 * that cannot be cloned. In the sandbox they are plain objects with the same
 * fields; the host converts in both directions.
 */
function toPlatformContent(item, scope) {
  if (!isObject(item) || !isObject(item.value)) return item;
  const v = item.value;
  if (item.type === 'tool-call' && typeof scope.LanguageModelToolCall === 'function') {
    return { ...item, value: new scope.LanguageModelToolCall(v) };
  }
  if (item.type === 'tool-response') {
    if (v.errorMessage !== undefined && typeof scope.LanguageModelToolError === 'function') {
      return { ...item, value: new scope.LanguageModelToolError(v) };
    }
    if (typeof scope.LanguageModelToolSuccess === 'function') {
      return { ...item, value: new scope.LanguageModelToolSuccess(v) };
    }
  }
  return item;
}

function toPlatformPrompt(input, scope) {
  if (!Array.isArray(input)) return input;
  return input.map((msg) => (isObject(msg) && Array.isArray(msg.content)
    ? { ...msg, content: msg.content.map((c) => toPlatformContent(c, scope)) }
    : msg));
}

function toPlainContent(item) {
  if (!isObject(item) || item.value === null || typeof item.value !== 'object') return item;
  const v = item.value;
  if (item.type === 'tool-call') {
    return { type: item.type, value: { callId: v.callId, name: v.name, arguments: v.arguments ?? null } };
  }
  if (item.type === 'tool-response') {
    return {
      type: item.type,
      value: v.errorMessage !== undefined
        ? { callId: v.callId, name: v.name, errorMessage: v.errorMessage }
        : { callId: v.callId, name: v.name, result: v.result ? [...v.result] : [] },
    };
  }
  return item;
}

function toPlainResult(value) {
  return Array.isArray(value) ? value.map(toPlainContent) : value;
}

/**
 * Create the Chrome built-in AI bridge.
 *
 * @param {object} [options]
 * @param {string[]} [options.apis]  which APIs to expose (default: all of CHROME_AI_APIS)
 * @param {(request: object) => boolean | Promise<boolean>} [options.onRequest]  consent hook; only `true` allows
 * @param {{ maxInputTokens?: number, maxInputTokensPerCall?: number }} [options.budgets]  token budgets per sandbox
 * @param {object} [options.limits]  bridge limits (default { maxHandles: 8, maxStreams: 4 })
 * @param {boolean} [options.globals]  also install LanguageModel, Summarizer, ... as sandbox globals
 * @param {object} [options.scope]  where the platform constructors live (default globalThis; tests pass fakes)
 */
export function chromeAI(options = {}) {
  if (!isObject(options)) throw new TypeError('chromeAI(options): options must be an object');
  for (const k of Object.keys(options)) {
    if (!['apis', 'onRequest', 'budgets', 'limits', 'globals', 'scope'].includes(k)) {
      throw new TypeError(`chromeAI: '${k}' is not a known option (apis, onRequest, budgets, limits, globals, scope)`);
    }
  }
  const { apis = CHROME_AI_APIS, onRequest, budgets = {}, limits = {}, globals = false, scope = globalThis } = options;
  if (!Array.isArray(apis) || !apis.every((a) => CHROME_AI_APIS.includes(a))) {
    throw new TypeError(`chromeAI: apis must be an array of ${CHROME_AI_APIS.map((a) => `'${a}'`).join(', ')}`);
  }
  if (!isObject(budgets)) throw new TypeError('chromeAI: budgets must be an object');
  for (const k of Object.keys(budgets)) {
    if (!['maxInputTokens', 'maxInputTokensPerCall'].includes(k)) {
      throw new TypeError(`chromeAI: budgets.${k} is not a known budget (maxInputTokens, maxInputTokensPerCall)`);
    }
    checkBudget('chromeAI: budgets', k, budgets[k]);
  }
  if (!isObject(scope)) throw new TypeError('chromeAI: scope must be an object');
  const maxTotal = budgets.maxInputTokens ?? 0;
  const maxPerCall = budgets.maxInputTokensPerCall ?? 0;

  /** Count model input against the budgets before it reaches the model. */
  async function charge(ctx, target, typeName, input, opts) {
    if (!maxTotal && !maxPerCall) return;
    const measure = typeof target.measureContextUsage === 'function'
      ? target.measureContextUsage
      : typeof target.measureInputUsage === 'function' ? target.measureInputUsage : null;
    if (!measure) {
      throw domError(`${typeName} cannot measure its input in this browser, so the token budget cannot be enforced`, 'NotSupportedError');
    }
    const { signal, ...measureOpts } = opts;
    const n = Number(await measure.call(target, input, { ...measureOpts, signal }));
    const tokens = Number.isFinite(n) ? n : 0;
    if (maxPerCall > 0 && tokens > maxPerCall) {
      throw Object.assign(domError(`Input is ${tokens} tokens, over budgets.maxInputTokensPerCall (${maxPerCall})`, 'QuotaExceededError'), { requested: tokens, quota: maxPerCall });
    }
    if (maxTotal > 0 && ctx.state.inputTokens + tokens > maxTotal) {
      throw Object.assign(
        domError(`Input of ${tokens} tokens would exceed budgets.maxInputTokens (${ctx.state.inputTokens} of ${maxTotal} used)`, 'QuotaExceededError'),
        { requested: tokens, quota: maxTotal - ctx.state.inputTokens }
      );
    }
    ctx.state.inputTokens += tokens;
  }

  const api = {};
  const handles = {};
  const aliases = {};
  for (const key of apis) {
    const info = API_TABLE[key];
    const typeName = info.global;
    const getAPI = () => {
      const C = scope[typeName];
      return typeof C === 'function' || isObject(C) ? C : null;
    };
    const coreOptions = (opts) => {
      if (!isObject(opts)) return opts;
      const out = {};
      for (const k of Object.keys(opts)) if (!NOT_FOR_AVAILABILITY.has(k)) out[k] = opts[k];
      return out;
    };

    const ns = {
      async availability(ctx, opts) {
        const C = getAPI();
        if (!C || typeof C.availability !== 'function') return 'unavailable';
        return C.availability(coreOptions(opts));
      },
      create: {
        handle: true,
        // Chrome needs a user gesture when the model still has to be
        // downloaded (sticky activation is enough in shipping Chrome).
        async requiresUserActivation(ctx, opts) {
          const C = getAPI();
          if (!C || typeof C.availability !== 'function') return false;
          try {
            return (await C.availability(coreOptions(opts))) === 'downloadable' ? 'sticky' : false;
          } catch {
            return false;
          }
        },
        async call(ctx, opts) {
          const C = getAPI();
          if (!C || typeof C.create !== 'function') {
            throw domError(`${typeName} is not available in this browser`, 'NotSupportedError');
          }
          let createOpts = opts;
          if (isObject(opts)) {
            const { monitor, onDownloadProgress, signal, ...rest } = opts;
            if (Array.isArray(rest.tools) && rest.tools.some((t) => isObject(t) && typeof t.execute === 'function')) {
              throw domError(
                "Prompt API tools have no execute() callback: tool use is open-loop (prompt() returns 'tool-call' content " +
                "and you append a 'tool-response'). Drop execute from the tool declarations.",
                'NotSupportedError'
              );
            }
            createOpts = { ...rest, signal: ctx.signal };
            if (Array.isArray(rest.initialPrompts)) createOpts.initialPrompts = toPlatformPrompt(rest.initialPrompts, scope);
            if (typeof onDownloadProgress === 'function') {
              createOpts.monitor = (m) => {
                m.addEventListener('downloadprogress', (e) => {
                  onDownloadProgress({ loaded: e.loaded, total: e.total }).catch(() => {});
                });
              };
            }
          } else if (opts === undefined) {
            createOpts = { signal: ctx.signal };
          }
          const instance = await C.create(createOpts);
          // The tokens initial prompts already used count against the budget.
          if (maxTotal > 0 && key === 'languageModel') {
            const used = Number(instance?.contextUsage ?? instance?.inputUsage ?? 0);
            if (Number.isFinite(used) && used > 0) {
              if (ctx.state.inputTokens + used > maxTotal) {
                try { instance.destroy?.(); } catch {}
                throw Object.assign(
                  domError(`initialPrompts use ${used} tokens, over budgets.maxInputTokens (${ctx.state.inputTokens} of ${maxTotal} used)`, 'QuotaExceededError'),
                  { requested: used, quota: maxTotal - ctx.state.inputTokens }
                );
              }
              ctx.state.inputTokens += used;
            }
          }
          return ctx.handle(typeName, instance);
        },
      },
    };
    if (key === 'languageModel' && typeof scope.LanguageModel?.params === 'function') {
      // Extension contexts only; LanguageModelParams is a platform object.
      ns.params = async () => {
        const p = await scope.LanguageModel.params();
        return p == null ? null : {
          defaultTopK: p.defaultTopK, maxTopK: p.maxTopK, defaultTemperature: p.defaultTemperature, maxTemperature: p.maxTemperature,
        };
      };
    }
    api[key] = ns;

    const methods = {};
    for (const [name, m] of Object.entries(info.methods)) {
      const call = async (ctx, ...args) => {
        const target = ctx.target;
        let fn = target[name];
        if (typeof fn !== 'function' && m.alias) fn = target[m.alias];
        if (typeof fn !== 'function') {
          throw domError(`${typeName}.${name}() is not available in this browser`, 'NotSupportedError');
        }
        const a = args.slice();
        while (a.length <= m.opts) a.push(undefined);
        const opts = isObject(a[m.opts]) ? { ...a[m.opts] } : {};
        opts.signal = ctx.signal;
        a[m.opts] = opts;
        if (key === 'languageModel' && m.opts === 1) a[0] = toPlatformPrompt(a[0], scope);
        if (m.input) await charge(ctx, target, typeName, a[0], opts);
        const result = fn.apply(target, a);
        if (m.stream) return result;
        if (m.handle) return ctx.handle(typeName, await result);
        return toPlainResult(await result);
      };
      methods[name] = { call, stream: m.stream === true, handle: m.handle === true };
    }
    handles[typeName] = {
      methods,
      props: info.props,
      destroy: (target) => target.destroy?.(),
    };
    aliases[typeName] = key;
  }

  return defineBridge({
    api,
    handles,
    limits: { ...DEFAULT_LIMITS, ...limits },
    ...(onRequest !== undefined ? { onRequest } : {}),
    createState: () => ({ inputTokens: 0 }),
    stats: (state) => ({ inputTokens: state.inputTokens }),
    client: chromeAIClient,
    ...(globals ? { globals: aliases } : {}),
  });
}
