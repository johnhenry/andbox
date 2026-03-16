/**
 * andbox — Sandboxed JavaScript runtime.
 *
 * TypeScript type definitions for all public API exports.
 */

// ── constants ──

/** Default timeout for evaluate() in milliseconds (30 000). */
export declare const DEFAULT_TIMEOUT_MS: 30000;

/** Default resource limits for capability gating. */
export declare const DEFAULT_LIMITS: Readonly<{
  /** Max capability calls per sandbox lifetime (0 = unlimited). */
  maxCalls: 0;
  /** Max total argument bytes across all calls (0 = unlimited). */
  maxArgBytes: 0;
  /** Max concurrent pending capability calls. */
  maxConcurrent: 16;
}>;

/** Default per-capability limits. */
export declare const DEFAULT_CAPABILITY_LIMITS: Readonly<{
  /** Max argument bytes for a single call to this capability (0 = unlimited). */
  maxArgBytes: 0;
  /** Max calls to this specific capability (0 = unlimited). */
  maxCalls: 0;
}>;

// ── deferred ──

/** A deferred promise with externally accessible resolve/reject. */
export interface Deferred<T = unknown> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

/** Create a deferred promise with external resolve/reject. */
export declare function makeDeferred<T = unknown>(): Deferred<T>;

/** Create a DOMException with name "AbortError". */
export declare function makeAbortError(message?: string): DOMException;

/** Create an Error with name "TimeoutError". */
export declare function makeTimeoutError(ms: number): Error;

// ── capability-gate ──

/** Resource limits for capability gating. */
export interface GateLimits {
  /** Max capability calls per sandbox lifetime (0 = unlimited). */
  maxCalls?: number;
  /** Max total argument bytes across all calls (0 = unlimited). */
  maxArgBytes?: number;
  /** Max concurrent pending capability calls. */
  maxConcurrent?: number;
}

/** Per-capability limits. */
export interface CapabilityLimits {
  /** Max argument bytes for a single call to this capability (0 = unlimited). */
  maxArgBytes?: number;
  /** Max calls to this specific capability (0 = unlimited). */
  maxCalls?: number;
}

/** Rate limiting policy for gateCapabilities. */
export interface GatePolicy {
  /** Global resource limits. */
  limits?: GateLimits;
  /** Per-capability limit overrides, keyed by capability name. */
  capabilities?: Record<string, CapabilityLimits>;
}

/** Per-capability usage statistics. */
export interface CapabilityStats {
  calls: number;
  argBytes: number;
}

/** Aggregate gate statistics returned by stats(). */
export interface GateStatsResult {
  totalCalls: number;
  totalArgBytes: number;
  concurrent: number;
  perCapability: Record<string, CapabilityStats>;
}

/** Result of gateCapabilities(). */
export interface GateResult {
  /** Capability functions wrapped with rate-limiting enforcement. */
  gated: Record<string, (...args: unknown[]) => Promise<unknown>>;
  /** Returns current gate statistics. */
  stats: () => GateStatsResult;
}

/**
 * Gate capabilities with rate limiting and payload caps.
 *
 * Wraps a capabilities object with a Proxy that enforces global call count
 * limits, global argument byte limits, per-capability limits, and concurrent
 * call limits.
 */
export declare function gateCapabilities(
  capabilities: Record<string, (...args: any[]) => any>,
  policy?: GatePolicy,
): GateResult;

// ── import-map-resolver ──

/** An import map following the WICG import maps spec (subset). */
export interface ImportMap {
  /** Bare specifier to URL mappings. */
  imports?: Record<string, string>;
  /** Per-scope specifier to URL mappings. */
  scopes?: Record<string, Record<string, string>>;
}

/**
 * Resolve a specifier using an import map.
 *
 * Supports `imports` (bare specifier to URL) and `scopes` (per-prefix overrides).
 *
 * @param specifier  The import specifier (bare or relative).
 * @param importMap  The import map to resolve against.
 * @param parentURL  The URL of the importing module (for scopes).
 * @returns Resolved URL or null if no match.
 */
export declare function resolveWithImportMap(
  specifier: string,
  importMap: ImportMap | null | undefined,
  parentURL?: string,
): string | null;

// ── network-policy ──

/**
 * Create a fetch function that enforces a URL hostname allowlist.
 *
 * @param allowedHosts  Array of allowed hostnames. If empty/null, all hosts are allowed.
 * @param fetchFn       The fetch implementation to wrap (defaults to globalThis.fetch).
 * @returns A gated fetch function.
 */
export declare function createNetworkFetch(
  allowedHosts?: string[] | null,
  fetchFn?: typeof globalThis.fetch,
): (url: string, init?: RequestInit) => Promise<Response>;

// ── stdio ──

/** An async iterable stdio stream with push/end controls. */
export interface StdioStream {
  /** Push a message to the stream. No-op after end(). */
  push: (msg: string) => void;
  /** Signal the end of the stream. */
  end: () => void;
  /** The async iterable stream of messages. */
  stream: AsyncIterable<string>;
}

/**
 * Create an async iterable stdio stream.
 * Push messages via push(), close via end().
 */
export declare function createStdio(): StdioStream;

// ── worker-source ──

/**
 * Generate the Worker source code as a string.
 *
 * The Worker supports configure, defineModule, evaluate, and dispose messages
 * from the host, and sends configured, moduleDefined, result, capabilityCall,
 * and console messages back.
 *
 * @returns The complete Worker script source code as a string.
 */
export declare function makeWorkerSource(): string;

// ── sandbox ──

/** Options for evaluate(). */
export interface EvaluateOptions {
  /** Timeout in milliseconds for this evaluation (overrides sandbox default). */
  timeoutMs?: number;
  /** AbortSignal to cancel the evaluation. */
  signal?: AbortSignal;
  /** Console output handler for this evaluation (overrides sandbox-level handler). */
  onConsole?: (level: string, ...args: string[]) => void;
}

/** Options for createSandbox(). */
export interface SandboxOptions {
  /** Import map for module resolution inside the sandbox. */
  importMap?: ImportMap;
  /** Host functions callable from sandbox code via host.call(name, ...args). */
  capabilities?: Record<string, (...args: any[]) => any>;
  /** Default timeout in milliseconds for evaluate() calls. */
  defaultTimeoutMs?: number;
  /** Base URL for resolving relative imports inside the sandbox. */
  baseURL?: string;
  /** Rate limiting policy for capability calls. */
  policy?: GatePolicy;
  /** Console output handler. Called when sandboxed code uses console.log/warn/error/etc. */
  onConsole?: (level: string, ...args: string[]) => void;
}

/** Sandbox statistics. */
export interface SandboxStats {
  disposed: boolean;
  pendingEvaluations: number;
  virtualModules: string[];
  gate: GateStatsResult;
}

/** A sandboxed JavaScript runtime instance. */
export interface Sandbox {
  /**
   * Evaluate JavaScript code in the sandbox.
   *
   * The code is wrapped in an async IIFE and can use `sandboxImport(specifier)`
   * to load modules and `host.call(name, ...args)` to invoke host capabilities.
   *
   * @param code  JavaScript code to execute.
   * @param opts  Evaluation options (timeout, signal, console handler).
   * @returns The return value of the evaluated code.
   */
  evaluate(code: string, opts?: EvaluateOptions): Promise<unknown>;

  /**
   * Define a virtual module accessible via sandboxImport() inside the sandbox.
   *
   * @param name    Module specifier (e.g. 'std/hello').
   * @param source  Module source code (ES module).
   */
  defineModule(name: string, source: string): Promise<void>;

  /**
   * Terminate the sandbox. Rejects all pending evaluations.
   * Calling dispose() multiple times is safe (subsequent calls are no-ops).
   */
  dispose(): Promise<void>;

  /**
   * Get sandbox statistics (gate stats, pending count, virtual module list, disposed state).
   */
  stats(): SandboxStats;

  /** Returns true if the sandbox has been disposed. */
  isDisposed(): boolean;
}

/**
 * Create a new sandboxed JavaScript runtime.
 *
 * The sandbox runs in an isolated Web Worker with:
 * - RPC-based capability calls (host.call)
 * - Import map resolution
 * - Virtual module definitions
 * - Timeout + hard kill + restart
 * - Console forwarding
 * - Capability gating with rate limits
 *
 * @param options  Sandbox configuration options.
 * @returns A promise that resolves to the sandbox instance.
 */
export declare function createSandbox(options?: SandboxOptions): Promise<Sandbox>;
