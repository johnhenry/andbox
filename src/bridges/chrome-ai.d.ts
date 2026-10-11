/**
 * `@johnhenry/andbox/bridges/chrome-ai`: Chrome's built-in AI APIs, bridged
 * into a sandbox (andbox#46). See the README section "Chrome AI bridge".
 */
import type { BridgeDefinition, BridgeLimits, BridgeRequest } from '../index.js';

/** The API keys `chromeAI({ apis })` accepts; each is a namespace of the sandbox global. */
export type ChromeAIApi =
  | 'languageModel'
  | 'summarizer'
  | 'writer'
  | 'rewriter'
  | 'translator'
  | 'languageDetector'
  | 'proofreader';

export declare const CHROME_AI_APIS: readonly ChromeAIApi[];

export interface ChromeAIBudgets {
  /**
   * Model input tokens per sandbox lifetime, measured with
   * `measureContextUsage()` (or `measureInputUsage()`) before each
   * prompt/append/summarize/write/rewrite/translate/detect/proofread call,
   * plus the tokens `initialPrompts` use at create(). Output tokens are not
   * counted. A call over budget rejects with QuotaExceededError before it
   * reaches the model. 0 = unlimited.
   */
  maxInputTokens?: number;
  /** Model input tokens of a single call. 0 = unlimited. */
  maxInputTokensPerCall?: number;
}

export interface ChromeAIOptions {
  /** Which APIs to expose (default: all). Missing ones on the host report 'unavailable'. */
  apis?: ChromeAIApi[];
  /**
   * Consent hook for every model call (`method` is e.g. 'languageModel.create'
   * or 'LanguageModel.prompt'). Only `true` allows. When
   * `requiresUserActivation` is 'sticky' (the model must be downloaded),
   * resolve from a click handler so the page has activation.
   */
  onRequest?: (request: BridgeRequest) => boolean | Promise<boolean>;
  budgets?: ChromeAIBudgets;
  /** Bridge limits. Default { maxHandles: 8, maxStreams: 4 }. */
  limits?: BridgeLimits;
  /** Also install LanguageModel, Summarizer, ... in the sandbox as aliases of `ai.languageModel`, ... */
  globals?: boolean;
  /** Where the platform constructors are looked up (default globalThis). For tests and polyfills. */
  scope?: Record<string, unknown>;
}

/**
 * A `tool-call` content value as the sandbox receives it from `prompt()`.
 * The platform's id is `callID` (Chrome returns ''); `callId` is the same
 * value under the name andbox 0.3.2 used.
 */
export interface ChromeAIToolCall {
  callID: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown> | null;
}

/**
 * A `tool-response` content value the sandbox sends back: `result` for
 * success, `errorMessage` for an error. Pass `callID` or `callId` (missing
 * means ''). `{ type: 'tool-call', value }` in `initialPrompts` or a prompt
 * takes the same id fields plus `name` and `arguments`.
 */
export type ChromeAIToolResponse =
  | { callID?: string; callId?: string; name: string; result: Array<{ type: string; value: unknown }> }
  | { callID?: string; callId?: string; name: string; errorMessage: string };

/** The Chrome built-in AI bridge: `createSandbox({ bridges: { ai: chromeAI() } })`. */
export declare function chromeAI(options?: ChromeAIOptions): BridgeDefinition<{ inputTokens: number }>;
