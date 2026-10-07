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

// ── virtual-module-registry ──

/**
 * A registry of in-memory files: each backed by its own `blob:` URL in a
 * browser, or an importable `andbox-vfs:` URL under Node (where files can
 * import each other relatively).
 */
export interface VirtualModuleRegistry {
  /**
   * Get the `blob:` URL registered for a path.
   *
   * @param path
   * @returns the blob URL, or null if the path is unknown
   */
  resolve(path: string): string | null;

  /**
   * Resolve a module specifier the way `import` would need to, from the
   * point of view of a given importing file: import-map resolution first,
   * then a relative-path (`./x.js`, `../x.js`) fallback against the known
   * file table, then null if neither matched.
   *
   * @param specifier
   * @param parentPath  path of the file doing the importing
   * @returns a resolved URL, or null if nothing matched
   */
  resolveSpecifier(specifier: string, parentPath?: string): string | null;

  /**
   * Register (or replace) a file at runtime. Replacing an existing path
   * revokes its previous blob URL before minting a new one.
   *
   * @returns the new blob URL
   */
  define(path: string, source: string): string;

  /** The source text registered for a path, or null. Works in every runtime. */
  source(path: string): string | null;

  /** Whether a path is registered. */
  has(path: string): boolean;

  /** All registered paths. */
  paths(): string[];

  /** Revoke every blob URL this registry has ever minted. */
  dispose(): void;

  /** Whether dispose() has been called. */
  isDisposed(): boolean;
}

/**
 * Create a registry of in-memory files, each backed by its own `blob:`
 * URL, with specifier resolution that combines import-map resolution
 * with a relative-path fallback against the known file table.
 *
 * @param files      path → source text
 * @param options    optional import map used for bare-specifier resolution
 */
export declare function createVirtualModuleRegistry(
  files?: Record<string, string>,
  options?: {
    importMap?: ImportMap;
    /** `'auto'` (default): Node hooks under Node, `blob:` elsewhere. */
    backend?: 'auto' | 'blob' | 'node';
  },
): VirtualModuleRegistry;

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

// ── service-worker-source ──

/**
 * Generate the Service Worker source code as a string, for `mode:
 * 'service-worker'`.
 *
 * Unlike makeWorkerSource() (whose output becomes a `blob:` URL passed to
 * `new Worker(...)`), Service Worker registration requires a real
 * same-origin http(s) scriptURL — a `blob:` URL is not accepted by the
 * platform. The caller is responsible for serving this string's content at
 * whatever path it passes as `scriptURL` to `createSandbox()`.
 *
 * @returns The complete Service Worker script source code as a string.
 */
export declare function makeServiceWorkerSource(): string;

// ── service-worker-response ──

/** A file served by `mode: 'service-worker'`. */
export interface ServedFile {
  body: string | ArrayBuffer;
  contentType?: string;
  status?: number;
  headers?: Record<string, string>;
}

/**
 * Given a request pathname and the known served-file map, produce the
 * Response the Service Worker's `fetch` handler would return for an
 * in-scope request, or null if it should fall through to the network.
 *
 * Pure logic factored out of the generated Service Worker script so it's
 * testable under plain Node (which has no `ServiceWorkerGlobalScope` at
 * all, but does have real `Response`/`Headers` globals).
 *
 * @param pathname
 * @param files  path → served-file map (Map or plain object)
 */
export declare function resolveServiceWorkerResponse(
  pathname: string,
  files: Map<string, ServedFile> | Record<string, ServedFile>,
): Response | null;

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
  /**
   * Worker mode selection. Omitted/`'worker'` uses a Web Worker, or
   * `node:worker_threads` automatically when run under Node with no global
   * `Worker`. `'node-worker'` forces the Node implementation.
   */
  mode?: 'worker' | 'node-worker';
  // Any other value throws: supported modes are 'worker', 'node-worker', 'inline', 'data-uri', 'service-worker'.
  /**
   * Supply the Worker implementation: given the worker script source, return
   * a Web-Worker-shaped object. Overrides automatic selection. See
   * `createNodeWorkerFactory()`.
   */
  workerFactory?: (source: string) => WorkerLike;
  /**
   * Node worker_threads options and opt-in hardening. Only valid with the
   * built-in Node mode (throws with a browser Worker or custom workerFactory).
   * A worker thread is NOT a security boundary even with `permissions: true`.
   */
  nodeWorker?: NodeWorkerOptions;
  /**
   * Node only (default false). When true the thread is unref'd while the
   * sandbox is idle so a forgotten sandbox does not keep the process alive;
   * it stays ref'd during startup, evaluate() and defineModule(). Without it
   * a live sandbox keeps the process alive until dispose().
   */
  unref?: boolean;
}

/** Options for the built-in Node worker_threads mode (`nodeWorker`). */
export interface NodeWorkerOptions {
  /**
   * Spawn the thread with Node's permission model (`--permission`), an
   * isolated `env` (`{}` unless `env` is given), a default 256 MB heap cap,
   * stripped `process` escapes, blocked `node:`/`file:` imports and captured
   * stdio. Does not restrict network or CPU.
   */
  permissions?: boolean;
  /** Environment for the thread. Default: a copy of `process.env` (or `{}` with `permissions`). */
  env?: Record<string, string>;
  /** Heap cap in megabytes (`resourceLimits.maxOldGenerationSizeMb`). */
  maxMemoryMb?: number;
  /** Raw `worker_threads` resourceLimits, merged over `maxMemoryMb`. */
  resourceLimits?: {
    maxOldGenerationSizeMb?: number;
    maxYoungGenerationSizeMb?: number;
    codeRangeSizeMb?: number;
    stackSizeMb?: number;
  };
  /** Extra thread `execArgv`, e.g. `['--allow-fs-read=/data']`. */
  execArgv?: string[];
  /** Route thread stdout/stderr to `onConsole('stdout' | 'stderr', text)`. Default: true with `permissions`. */
  captureStdio?: boolean;
}

/** The subset of the Web Worker interface andbox drives. */
export interface WorkerLike {
  onmessage: ((ev: { data: any }) => void) | null;
  onerror: ((ev: { message?: string }) => void) | null;
  postMessage(message: unknown): void;
  addEventListener(type: 'message', fn: (ev: { data: any }) => void): void;
  removeEventListener(type: 'message', fn: (ev: { data: any }) => void): void;
  terminate(): void;
}

/**
 * Node only: load `node:worker_threads` and return a synchronous factory that
 * runs andbox's worker source in a thread. Suitable for `workerFactory`.
 */
export declare function createNodeWorkerFactory(
  options?: NodeWorkerOptions,
): Promise<(source: string) => WorkerLike>;

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

/** Options for createSandbox({ mode: 'service-worker' }). */
export interface ServiceWorkerSandboxOptions {
  /** Mode discriminant. */
  mode: 'service-worker';
  /**
   * Real same-origin http(s) URL serving makeServiceWorkerSource()'s
   * output. A blob: URL is not accepted by the platform for Service
   * Worker registration.
   */
  scriptURL: string;
  /** Scope to register the Service Worker under. Defaults to scriptURL's own directory. */
  scope?: string;
  /** Initial path → content map. */
  files?: Record<string, string | ServedFile>;
  /**
   * A #13 virtual module registry to pull additional served content from
   * (its known paths' real blob content), reusing its path/blob
   * bookkeeping instead of a second one.
   */
  registry?: VirtualModuleRegistry;
}

/** A registered Service Worker instance backing a path → content map. */
export interface ServiceWorkerSandbox {
  /** The scriptURL this Service Worker was registered from. */
  scriptURL: string;
  /** The registration's actual scope. */
  scope: string;
  /**
   * Register (or replace) one served file.
   *
   * @param path
   * @param source
   * @param entryOpts  contentType/status/headers overrides
   */
  define(
    path: string,
    source: string,
    entryOpts?: { contentType?: string; status?: number; headers?: Record<string, string> },
  ): Promise<void>;
  /** Remove a served file; requests for it fall through to the network. */
  remove(path: string): Promise<void>;
  /** Unregister the Service Worker. */
  dispose(): Promise<void>;
  /** Returns true if dispose() has been called. */
  isDisposed(): boolean;
}

/**
 * Create a new sandboxed JavaScript runtime.
 *
 * The default (Worker) mode runs in an isolated Web Worker with:
 * - RPC-based capability calls (host.call)
 * - Import map resolution
 * - Virtual module definitions
 * - Timeout + hard kill + restart
 * - Console forwarding
 * - Capability gating with rate limits
 *
 * `mode: 'service-worker'` is a different shape entirely: it hosts a
 * path → content map behind a real, same-origin, HTTP-shaped scope
 * instead of evaluating code — see andbox#14 and README's Security model
 * section before using it for untrusted content.
 *
 * @param options  Sandbox configuration options.
 * @returns A promise that resolves to the sandbox instance.
 */
export declare function createSandbox(options?: SandboxOptions): Promise<Sandbox>;
export declare function createSandbox(
  options: ServiceWorkerSandboxOptions,
): Promise<ServiceWorkerSandbox>;
